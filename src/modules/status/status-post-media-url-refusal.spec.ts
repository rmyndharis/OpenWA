import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { StatusController } from './status.controller';
import { StatusService } from './status.service';
import { SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { applyGlobalValidation } from '../../config/app-validation';
import { resolveMediaBuffer } from '../../engine/adapters/baileys-messaging';
import type { MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * A status post takes its media by URL through the same loader as a send. A URL it cannot use is the caller's
 * input, so it answers 400 and leaves the send breaker alone, as a send does.
 *
 * The engine here is a stand-in whose only job is the first step an adapter takes: fetch the URL through the
 * shared loader, here by way of the Baileys helper `resolveMediaBuffer` (whatsapp-web.js reaches the same loader
 * through `toMessageMedia`). A server on this machine counts the requests that reach it, and SSRF_ALLOWED_HOSTS
 * lets the guard through to its loopback address.
 */
describe('a status post whose media URL the gateway does not fetch', () => {
  const RECIPIENTS = ['628123456789@c.us'];
  /** [route, the body field that holds its media] */
  const kinds = [
    ['send-image', 'image'],
    ['send-video', 'video'],
    ['send-voice', 'audio'],
  ] as const;

  let server: Server;
  let base: string;
  let requests: number;
  let app: INestApplication<App>;
  let pacing: { assertSendAllowed: jest.Mock; recordSendSuccess: jest.Mock; recordSendFailure: jest.Mock };

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests++;
      if (req.url?.startsWith('/moved')) {
        res.writeHead(302, { location: 'https://example.invalid/final.png' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([1, 2, 3]));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    pacing = { assertSendAllowed: jest.fn(), recordSendSuccess: jest.fn(), recordSendFailure: jest.fn() };
    const hooks = { execute: jest.fn().mockResolvedValue({ continue: true, data: undefined }) };
    const posted = (media: MediaInput, fallbackType: string) =>
      resolveMediaBuffer(media, undefined, fallbackType).then(() => ({
        statusId: 'S1',
        timestamp: new Date(),
        expiresAt: new Date(),
      }));
    const engine = {
      postImageStatus: (media: MediaInput) => posted(media, 'image/jpeg'),
      postVideoStatus: (media: MediaInput) => posted(media, 'video/mp4'),
      postVoiceStatus: (media: MediaInput) => posted(media, 'audio/ogg; codecs=opus'),
    };
    const service = new StatusService(
      { require: () => engine } as never,
      hooks as never,
      {} as never,
      {} as never,
      pacing as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [StatusController],
      providers: [{ provide: StatusService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = 0;
    process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
    pacing.recordSendFailure.mockClear();
  });

  afterEach(() => {
    delete process.env.SSRF_ALLOWED_HOSTS;
  });

  const post = (route: string, field: string, url: string) =>
    request(app.getHttpServer())
      .post(`/api/sessions/s1/status/${route}`)
      .send({ [field]: { url }, recipients: RECIPIENTS });

  describe('that carries credentials', () => {
    it.each(kinds)('answers 400 on POST status/%s, sends no request and spares the breaker', async (route, field) => {
      const res = await post(route, field, base.replace('http://', 'http://user:secret@'));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: 'Media URL must not contain credentials (userinfo)' });
      expect(JSON.stringify(res.body)).not.toContain('secret');
      expect(requests).toBe(0);
      expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    });

    it('still posts a URL whose userinfo is empty', async () => {
      const res = await post('send-image', 'image', base.replace('http://', 'http://@'));

      expect(res.status).toBe(201);
      expect(requests).toBe(1);
    });
  });

  describe('that the SSRF guard refuses', () => {
    it.each(kinds)('answers 400 on POST status/%s for an internal address, without naming it', async (route, field) => {
      const res = await post(route, field, 'http://10.0.0.1/x.png');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: SSRF_BLOCKED_CLIENT_MESSAGE });
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.1');
      expect(requests).toBe(0);
      expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    });

    it.each(kinds)(
      'answers 400 on POST status/%s for a URL that redirects, and does not follow it',
      async (route, field) => {
        const res = await post(route, field, `${base}/moved.png`);

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ message: SSRF_BLOCKED_CLIENT_MESSAGE });
        // The redirect itself was requested; its target never was.
        expect(requests).toBe(1);
        expect(pacing.recordSendFailure).not.toHaveBeenCalled();
      },
    );
  });
});
