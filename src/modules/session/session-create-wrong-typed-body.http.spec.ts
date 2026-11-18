import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { AuditService } from '../audit/audit.service';
import { ChatScopeService } from '../auth/chat-scope.service';
import { applyGlobalValidation } from '../../config/app-validation';

/**
 * The real validation pipes of the application (applyGlobalValidation) in front of the real session controller. A body
 * value of the wrong type is a caller mistake and has to answer 400, whatever shape the wrong value takes.
 */
describe('POST /api/sessions with a value of the wrong type', () => {
  let app: INestApplication<App>;
  const create = jest.fn();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [SessionController],
      providers: [
        { provide: SessionService, useValue: { create, engineLoaded: () => false } },
        { provide: AuditService, useValue: { logInfo: jest.fn() } },
        ChatScopeService,
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => create.mockReset());

  it.each([
    ['an object', { name: { a: 1 } }],
    ['an array', { name: ['abc'] }],
  ])('answers 400 for a name that is %s', async (_label, body) => {
    const res = await request(app.getHttpServer()).post('/api/sessions').send(body);

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  // String() and Number() throw on an object whose own toString is not a function, and the pipe's implicit conversion
  // calls them on whatever the caller sent.
  it.each([
    ['name', { name: { toString: 'x' } }],
    ['name with a numeric toString', { name: { toString: 1 } }],
    ['name inside an array', { name: [{ toString: 'x' }] }],
    ['proxyUrl', { name: 'abc', proxyUrl: { toString: 'x' } }],
  ])('answers 400, not 500, for an object with its own toString in %s', async (_label, body) => {
    const res = await request(app.getHttpServer()).post('/api/sessions').send(body);

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  // The urlencoded parser builds the same object from a bracketed key.
  it.each(['name[toString]=x', 'name=abc&proxyUrl[toString]=x'])(
    'answers 400, not 500, for the form-encoded %s',
    async form => {
      const res = await request(app.getHttpServer()).post('/api/sessions').type('form').send(form);

      expect(res.status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('still hands a sound body to the service', async () => {
    create.mockResolvedValue({ id: 's1', name: 'abc' });

    const res = await request(app.getHttpServer()).post('/api/sessions').send({ name: 'abc' });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
