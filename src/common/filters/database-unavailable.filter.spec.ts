import { Controller, Get, INestApplication, NotFoundException } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DatabaseError } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { type DataSource, QueryFailedError } from 'typeorm';
import { markEngineSendFailure } from '../errors/engine-send-failure';
import { LoggerService } from '../services/logger.service';
import { markConnectFailures } from '../utils/db-errors';
import {
  DATABASE_UNAVAILABLE_MESSAGE,
  DatabaseUnavailableFilter,
  markAfterEffect,
} from './database-unavailable.filter';

let thrown: Error;

@Controller('probe')
class ProbeController {
  @Get()
  fail(): never {
    throw thrown;
  }
}

/** What pg raises for an error the server answered, with the SQLSTATE it sent. */
const pgError = (message: string, code: string): DatabaseError =>
  Object.assign(new DatabaseError(message, message.length, 'error'), { severity: 'FATAL', code });
const sqliteError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { name: 'SqliteError', code });
/** What TypeORM raises for a statement that failed, on either dialect. */
const failedStatement = (driverError: Error): QueryFailedError => new QueryFailedError('SELECT 1', [], driverError);
const refusedSocket = (port: number): Error =>
  Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), {
    errno: -61,
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port,
  });

describe('DatabaseUnavailableFilter', () => {
  let withFilter: INestApplication<App>;
  let withoutFilter: INestApplication<App>;

  const boot = async (filtered: boolean): Promise<INestApplication<App>> => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: filtered ? [{ provide: APP_FILTER, useClass: DatabaseUnavailableFilter }] : [],
    }).compile();
    // Nest logs every error it answers with a 500; the rows read the answers, not that log.
    const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.init();
    return app;
  };

  const answer = async (app: INestApplication<App>, error: Error) => {
    thrown = error;
    const res = await request(app.getHttpServer()).get('/probe');
    return { status: res.status, body: res.body as unknown };
  };

  beforeAll(async () => {
    [withFilter, withoutFilter] = await Promise.all([boot(true), boot(false)]);
  });

  afterAll(async () => {
    await Promise.all([withFilter?.close(), withoutFilter?.close()]);
  });

  it.each<[string, Error]>([
    [
      'PostgreSQL refusing connections to the database',
      pgError('database "openwa" is not currently accepting connections', '55000'),
    ],
    ['PostgreSQL out of connections', pgError('sorry, too many clients already', '53300')],
    ['PostgreSQL starting up', pgError('the database system is starting up', '57P03')],
    [
      'a connection terminated under a statement',
      failedStatement(pgError('terminating connection due to administrator command', '57P01')),
    ],
    ['a connection lost under a statement', failedStatement(new Error('Connection terminated unexpectedly'))],
    ['a locked SQLite file', failedStatement(sqliteError('database is locked', 'SQLITE_BUSY'))],
    [
      'a SQLite file it cannot write to',
      failedStatement(sqliteError('attempt to write a readonly database', 'SQLITE_READONLY')),
    ],
    ['a full disk under SQLite', failedStatement(sqliteError('database or disk is full', 'SQLITE_FULL'))],
  ])('answers 503 to %s, and logs the driver text', async (_label, error) => {
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);

    expect(await answer(withFilter, error)).toEqual({
      status: 503,
      body: { statusCode: 503, message: DATABASE_UNAVAILABLE_MESSAGE, error: 'Service Unavailable' },
    });
    expect(warn).toHaveBeenCalledWith('The database could not serve a request', {
      method: 'GET',
      path: '/probe',
      error: error.message,
      action: 'request_database_unavailable',
    });
    warn.mockRestore();
  });

  it.each<[string, Error]>([
    ['a closed WhatsApp connection', new Error('Connection Closed')],
    ['a closed Redis connection', new Error('Connection is closed.')],
    ['a closed browser connection', new Error('Protocol error: Connection closed.')],
    ['a socket another dependency refused', refusedSocket(6379)],
    ['a statement the database rejected', failedStatement(sqliteError('near "FROM": syntax error', 'SQLITE_ERROR'))],
    ['a duplicate', failedStatement(pgError('duplicate key value violates unique constraint "x"', '23505'))],
    // The message names a connection, which reads as unavailable; the SQLSTATE says the statement itself was refused.
    [
      'a missing value in a column named after a connection',
      failedStatement(
        pgError('null value in column "connectionId" of relation "sessions" violates not-null constraint', '23502'),
      ),
    ],
    [
      'a table named after a connection that does not exist',
      failedStatement(pgError('relation "connection_log" does not exist', '42P01')),
    ],
    ['a refused login', pgError('password authentication failed for user "openwa"', '28P01')],
    [
      "a value the database refused, quoting the caller's text",
      failedStatement(pgError('invalid input syntax for type uuid: "my-connection"', '22P02')),
    ],
    [
      "a SQLite statement it refused, quoting the caller's text",
      failedStatement(sqliteError('fts5: syntax error near "connection"', 'SQLITE_ERROR')),
    ],
    ['a refusal whose text quotes a connection', new NotFoundException('Connection abc not found')],
    [
      'a failure raised once the request had acted',
      markAfterEffect(pgError('database "openwa" is not currently accepting connections', '55000')),
    ],
    [
      'a send whose engine call failed before the database did',
      markEngineSendFailure(pgError('database "openwa" is not currently accepting connections', '55000')),
    ],
  ])('answers %s exactly as Nest does without it', async (_label, error) => {
    const expected = await answer(withoutFilter, error);

    expect(await answer(withFilter, error)).toEqual(expected);
    expect(expected.status).not.toBe(503);
  });

  // Retry-After would invite a client to replay a write without a key, which may already have taken effect.
  it('sends its 503 without a Retry-After', async () => {
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    thrown = pgError('database "openwa" is not currently accepting connections', '55000');

    const res = await request(withFilter.getHttpServer()).get('/probe');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBeUndefined();
    jest.restoreAllMocks();
  });

  it('answers 503 to a socket the data connection could not open, a shape it answers 500 to from any other client', async () => {
    const driver = { obtainMasterConnection: () => Promise.reject(refusedSocket(5432)) };
    markConnectFailures({ driver } as unknown as DataSource);
    const refused = await driver.obtainMasterConnection().catch((error: Error) => error);

    expect((await answer(withFilter, refused)).status).toBe(503);
    expect((await answer(withFilter, refusedSocket(5432))).status).toBe(500);
  });

  it('leaves a thrown value that is not an object as it is', () => {
    expect(markAfterEffect('not an object')).toBe('not an object');
  });
});
