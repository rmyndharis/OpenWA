import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { loadRemoteMediaBuffer } from './load-remote-media';
import { isMediaUrl } from './media-url';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';
import { sanitizeBatchError } from '../../modules/message/bulk-message.service';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/run-idempotent-send';
import { provesNothingSent } from '../errors/engine-not-sent.error';
import { SendMediaMessageDto } from '../../modules/message/dto/send-message.dto';
import { ConvertMediaDto } from '../../modules/media/dto/convert-media.dto';

/**
 * A media URL is the caller's input. One that carries a user name or password passes the shared URL rule, and
 * the HTTP client then refuses to build the request. The refusal has to leave as the same client error every
 * other unfetchable URL does, with the proof that nothing was sent: as a raw TypeError it is a 500, it counts
 * toward the send-pacing breaker of a healthy session, it keeps the Idempotency-Key, and its message repeats
 * the credentials into the log and the message:failed hook payload.
 *
 * Runs against the real HTTP client (no mock) and a server on this machine, so a request that did go out is
 * counted rather than assumed away. SSRF_ALLOWED_HOSTS lets the guard through to the loopback address.
 */
describe('a media URL that carries credentials', () => {
  const MESSAGE = 'Media URL must not contain credentials (userinfo)';
  let server: Server;
  let port: number;
  let requests: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([1, 2, 3]));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = 0;
    process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
  });

  afterEach(() => {
    delete process.env.SSRF_ALLOWED_HOSTS;
  });

  const urlWith = (userinfo: string, scheme = 'http'): string => `${scheme}://${userinfo}127.0.0.1:${port}/x.png`;
  const failureOf = (url: string): Promise<unknown> =>
    loadRemoteMediaBuffer(url, undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

  it('passes the shared media URL rule, so a send route hands it to the fetch', async () => {
    const url = urlWith('user:secret@');
    expect(isMediaUrl(url)).toBe(true);
    const send = plainToInstance(SendMediaMessageDto, { chatId: '628123456789@c.us', url });
    expect(await validate(send)).toEqual([]);
    expect(await validate(plainToInstance(ConvertMediaDto, { url }))).toEqual([]);
  });

  it.each([
    ['a user name', 'user@', 'http'],
    ['a password', ':secret@', 'http'],
    ['a user name and a password', 'user:secret@', 'http'],
    ['percent-encoded credentials', 'us%40er:s%3Acret@', 'http'],
    ['credentials behind an upper-case scheme', 'user:secret@', 'HTTP'],
  ])('is refused when it has %s: a 400 that proves nothing was sent', async (_label, userinfo, scheme) => {
    const error = await failureOf(urlWith(userinfo, scheme));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    expect((error as BadRequestException).message).toBe(MESSAGE);
    expect((error as BadRequestException).message).not.toContain(userinfo);
    // Nothing reached the server: the request was refused before a connection existed.
    expect(requests).toBe(0);
  });

  it('is classified as a client error that leaves the breaker, the admission and the key alone', async () => {
    const error = await failureOf(urlWith('user:secret@'));

    expect(provesNothingSent(error)).toBe(true);
    expect(sentNothing(error)).toBe(true);
    expect(countsTowardSendBreaker(error)).toBe(false);
    // A keyed send frees its Idempotency-Key, so the identical retry runs instead of answering 409.
    expect(sendFailureProvesNothingSent(error)).toBe(true);
    // A bulk item stores the text as it is: it must not repeat the credentials.
    expect(sanitizeBatchError(error)).toEqual({ code: 'SEND_FAILED', message: MESSAGE });
  });

  // undici accepts an empty user name and password, so a URL that only has the separator is still fetched.
  it.each(['@', ':@'])('is fetched when the userinfo is empty (%s)', async userinfo => {
    const media = await loadRemoteMediaBuffer(urlWith(userinfo), undefined);

    expect(media.mimetype).toBe('image/png');
    expect(Array.from(media.data)).toEqual([1, 2, 3]);
    expect(requests).toBe(1);
  });
});
