/**
 * Boot-env contract for the e2e family: setup-e2e.ts (a jest setupFile) runs before every suite,
 * so each suite must boot with queue and Redis off regardless of an ambient REDIS_ENABLED or
 * QUEUE_ENABLED inherited from the developer's shell or the CI env. Writes from an earlier suite
 * cannot carry over: jest gives each test file its own copy of process.env. Run in a clean env
 * this passes trivially; its regression value is in a dirty ambient env, where a missing reset
 * shows up as REDIS_ENABLED !== 'false' here.
 */
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';

describe('e2e boot environment', () => {
  it('boots with queue and Redis disabled', () => {
    expect(process.env.QUEUE_ENABLED).toBe('false');
    expect(process.env.REDIS_ENABLED).toBe('false');
  });

  // The boot sweep deletes an archive in the checkout's ./data/exports once its embedded creation time is
  // this many milliseconds old, so an age past the current epoch time deletes none.
  it('boots with an export sweep that deletes no archive from the checkout', () => {
    expect(Number(process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS)).toBeGreaterThan(Date.now());
  });
});

@Controller()
class PingController {
  @Get('/__bind-probe')
  probe(): { servedBy: string } {
    return { servedBy: 'the app under test' };
  }
}

/** A standalone app for the `listen()` handover, which needs a real NestFactory app rather than a fixture. */
@Module({})
class BareModule {}

/**
 * The listening contract setup-e2e.ts enforces, and the reason it exists.
 *
 * supertest starts a server per request with `listen(0)` and no host, which binds the wildcard
 * address, and then dials 127.0.0.1 regardless of what it bound. macOS hands a wildcard listener an
 * ephemeral port another process already holds on 127.0.0.1 specifically, allows the overlapping bind,
 * and routes the loopback connection to the more specific binding, so that process answers instead of
 * the app. The lane saw this as statuses no route can return, on a different test each run.
 *
 * setup-e2e.ts closes it by listening on 127.0.0.1 during `init()`, which is also the condition
 * supertest branches on: a server that already has an address is reused rather than replaced. Both
 * halves are asserted, because either one alone can hold while the protection is gone. Listening on
 * the wildcard address still satisfies the second test, and never listening at all still satisfies
 * neither, so the pair fails on a different side depending on which half was lost.
 *
 * The last two cover what taking that port early costs elsewhere: a bind that fails has to be
 * reported rather than stall the boot, and an app that goes on to call `listen()` has to get its own
 * socket back.
 */
describe('e2e listener bind contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('leaves the app listening on loopback, not the wildcard address', () => {
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    expect(address).not.toBeNull();
    expect(address.address).toBe('127.0.0.1');
  });

  it('is the server that answers, so supertest never opens a wildcard one of its own', async () => {
    const server = app.getHttpServer() as Server;
    // Not "the port stayed the same": that holds either way. supertest opening its own listener is a
    // `listen` call, so the call itself is what has to be absent.
    const listen = jest.spyOn(Server.prototype, 'listen');
    try {
      await request(server).get('/__bind-probe').expect(200, { servedBy: 'the app under test' });
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  });

  // A bind failure is reported on 'error', never through the listen callback. Waiting on the callback
  // alone stalls init() and lets Node throw the event with nothing listening, so the failure lands
  // detached from the boot that caused it.
  it('reports a failed bind instead of leaving init pending', async () => {
    const failing = jest.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
      process.nextTick(() => this.emit('error', Object.assign(new Error('bind refused'), { code: 'EADDRINUSE' })));
      return this;
    });
    const stalled = await NestFactory.create(BareModule, { logger: false });
    try {
      await expect(stalled.init()).rejects.toThrow('bind refused');
    } finally {
      failing.mockRestore();
      await stalled.close().catch(() => undefined);
    }
  });

  // Taking a port during init puts one on the same socket `listen()` wants, so without a handover it
  // answers ERR_SERVER_ALREADY_LISTEN on a call that has nothing wrong with it. No suite calls
  // `app.listen()` today, which is exactly why the breakage would surface as a puzzle later.
  it('still lets an app call listen() afterwards, and puts that on loopback too', async () => {
    const standalone = await NestFactory.create(BareModule, { logger: false });
    try {
      await standalone.listen(0);
      const address = (standalone.getHttpServer() as Server).address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
    } finally {
      await standalone.close();
    }
  });
});
