import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ConflictException, Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { EngineNotReadyError } from './engine-not-ready.error';
import {
  ENGINE_PAGE_RELOADING,
  EnginePageReloadingError,
  PAGE_RELOADING_MESSAGE,
  PAGE_RELOADING_RETRY_AFTER_SECONDS,
} from './engine-page-reloading.error';

@Controller('send')
class SendController {
  /** A send the engine refuses while its page reloads. */
  @Post()
  send(): never {
    throw new EnginePageReloadingError();
  }
}

/**
 * The 409 a whatsapp-web.js session answers while WhatsApp Web reloads its page. The session reads `ready` and no
 * event ends the window, so the body is all a client has: a `code` to tell it from every other conflict, and the
 * interval to ask again at.
 */
describe('EnginePageReloadingError', () => {
  it('answers 409 with a stable code and the interval to ask again at', () => {
    const error = new EnginePageReloadingError();

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: PAGE_RELOADING_MESSAGE,
      code: 'ENGINE_PAGE_RELOADING',
      retryAfterSeconds: 5,
    });
    expect(ENGINE_PAGE_RELOADING).toBe('ENGINE_PAGE_RELOADING');
    expect(PAGE_RELOADING_RETRY_AFTER_SECONDS).toBe(5);
  });

  it('keeps the text as its message, for the callers that log it or pass only that on', () => {
    expect(new EnginePageReloadingError().message).toBe(PAGE_RELOADING_MESSAGE);
  });

  it('is the not-ready conflict every caller already handles', () => {
    const error = new EnginePageReloadingError();

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(error).toBeInstanceOf(ConflictException);
  });

  it('leaves the plain not-ready 409 with the three default fields', () => {
    expect(new EngineNotReadyError().getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Session is not connected. The WhatsApp client is not ready.',
    });
    expect(new EngineNotReadyError('gone').getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'gone',
    });
  });

  // No filter shapes the errors of this gateway: what the exception holds is what the client reads.
  it('reaches the client as that body', async () => {
    const module = await Test.createTestingModule({ controllers: [SendController] }).compile();
    const app: INestApplication<App> = module.createNestApplication();
    await app.init();
    try {
      const answer = await request(app.getHttpServer()).post('/send');

      expect(answer.status).toBe(409);
      expect(answer.body).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: PAGE_RELOADING_MESSAGE,
        code: 'ENGINE_PAGE_RELOADING',
        retryAfterSeconds: 5,
      });
    } finally {
      await app.close();
    }
  });

  // A reload refusal built by hand from the message would answer without the code and the interval.
  it('is how every adapter file answers a reload: none builds the refusal from the message', () => {
    const adapters = join(__dirname, '../../engine/adapters');
    const byHand = readdirSync(adapters)
      .filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
      .filter(name =>
        /new EngineNotReadyError\(\s*PAGE_RELOADING_MESSAGE/.test(readFileSync(join(adapters, name), 'utf8')),
      );

    expect(byHand).toEqual([]);
  });
});
