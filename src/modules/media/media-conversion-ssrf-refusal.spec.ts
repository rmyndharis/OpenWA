import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import * as dnsPromises from 'dns/promises';
import { MediaConversionService } from './media-conversion.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session } from '../session/entities/session.entity';
import * as ffmpeg from './ffmpeg';
import { LoggerService } from '../../common/services/logger.service';
import { SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';

// The real resolver unless a case overrides one lookup, so the 127.0.0.1 redirect server below stays reachable.
jest.mock('dns/promises', () => {
  const actual = jest.requireActual<typeof import('dns/promises')>('dns/promises');
  return { __esModule: true, ...actual, lookup: jest.fn(actual.lookup) };
});

/**
 * A conversion URL the SSRF guard refuses is the caller's input, like the URL of a send, a status post or a
 * picture: the client gets the generic 400, and the guard's own account of the refusal, which names the resolved
 * address, stays in the server log so an operator can tell a blocked address from a missing SSRF_ALLOWED_HOSTS entry.
 *
 * Runs the real service, the real loader and the real guard. The blocked address is an IP literal, so no name is
 * resolved and no connection is made; the redirect case talks to a server on this machine.
 */
describe('a media conversion whose url the SSRF guard refuses', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';
  let logged: jest.SpyInstance[];
  let server: Server;
  let base: string;

  const service = (): MediaConversionService => {
    const values: Record<string, unknown> = {
      'mediaConversion.enabled': true,
      'mediaConversion.ffmpegPath': 'ffmpeg',
      'mediaConversion.timeoutMs': 60_000,
      'mediaConversion.maxOutputBytes': 50 * 1024 * 1024,
    };
    const config = { get: (key: string, fallback?: unknown) => values[key] ?? fallback } as unknown as ConfigService;
    const sessions = { findOne: jest.fn().mockResolvedValue(null) } as unknown as Repository<Session>;
    return new MediaConversionService(config, new EngineRegistry(), sessions);
  };

  const failureOf = (url: string, route: 'convertToVoice' | 'convertToVideo' = 'convertToVoice'): Promise<unknown> =>
    service()
      [route](SESSION, { url })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

  // Every level the logger has: the claim is that the detail reaches no log line at all.
  const loggedLines = (): string[] =>
    logged.flatMap(spy => (spy.mock.calls as unknown[][]).map(call => String(call[0])));

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(302, { location: 'https://example.invalid/final.mp3' }).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    jest.spyOn(ffmpeg, 'probeFfmpeg').mockResolvedValue(true);
    jest.spyOn(ffmpeg, 'runFfmpeg').mockResolvedValue(Buffer.from('converted'));
    logged = (['log', 'warn', 'error', 'debug'] as const).map(level =>
      jest.spyOn(LoggerService.prototype, level).mockImplementation(() => undefined),
    );
    process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
  });

  afterEach(() => {
    delete process.env.SSRF_ALLOWED_HOSTS;
    jest.restoreAllMocks();
  });

  it('answers a generic 400 that never names the address', async () => {
    const error = await failureOf('http://10.0.0.1/note.mp3');

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    expect((error as BadRequestException).message).toBe(SSRF_BLOCKED_CLIENT_MESSAGE);
    expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain('10.0.0.1');
    expect(ffmpeg.runFfmpeg).not.toHaveBeenCalled();
  });

  it('keeps the guard detail in the server log, as a send does', async () => {
    await failureOf('http://10.0.0.1/note.mp3');

    expect(loggedLines().some(line => line.includes('10.0.0.1'))).toBe(true);
  });

  it('keeps the guard detail in the server log on the video route too', async () => {
    const error = await failureOf('http://10.0.0.2/clip.mp4', 'convertToVideo');

    expect((error as BadRequestException).message).toBe(SSRF_BLOCKED_CLIENT_MESSAGE);
    expect(loggedLines().some(line => line.includes('10.0.0.2'))).toBe(true);
  });

  it('keeps the reason for a redirect in the server log', async () => {
    const error = await failureOf(`${base}/moved.mp3`);

    expect((error as BadRequestException).message).toBe(SSRF_BLOCKED_CLIENT_MESSAGE);
    expect(loggedLines().some(line => line.includes('Refusing to follow redirect'))).toBe(true);
  });

  it('keeps the reason for a name that does not resolve in the server log', async () => {
    (dnsPromises.lookup as unknown as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo ENOTFOUND files.example'), { code: 'ENOTFOUND' }),
    );

    const error = await failureOf('http://files.example/note.mp3');

    expect((error as BadRequestException).message).toBe(SSRF_BLOCKED_CLIENT_MESSAGE);
    expect(loggedLines().some(line => line.includes('Could not resolve host: files.example (ENOTFOUND)'))).toBe(true);
  });
});
