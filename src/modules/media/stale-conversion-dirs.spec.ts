import * as fs from 'fs';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';

// The temp dir the gateway works in (TMPDIR in production), pointed at a directory each test owns.
jest.mock('node:os', () => ({ ...jest.requireActual<typeof import('node:os')>('node:os'), tmpdir: jest.fn() }));

import { tmpdir } from 'node:os';
import * as ffmpeg from './ffmpeg';
import { MediaConversionService } from './media-conversion.service';

const realTmp = jest.requireActual<typeof import('node:os')>('node:os').tmpdir();
const gatewayTmp = tmpdir as jest.Mock;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A gateway killed mid-conversion (SIGKILL, the OOM killer) never reaches the `finally` that removes the
 * conversion's temp directory, and a disk-backed /tmp outlives the container. The next start clears them.
 */
describe('conversion directories left behind by a killed process', () => {
  let root: string;
  let outside: string;

  /** A directory under the temp root whose mtime is `ageMs` in the past. */
  const leftover = (name: string, ageMs: number): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'in.bin'), 'input');
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, at, at);
    return dir;
  };

  const service = (timeoutMs?: number): MediaConversionService =>
    new MediaConversionService(
      {
        get: (key: string, fallback?: unknown) =>
          key === 'mediaConversion.timeoutMs' && timeoutMs !== undefined ? timeoutMs : fallback,
      } as unknown as ConfigService,
      {} as never,
      {} as never,
    );

  /** Start the service the way Nest does. */
  const start = (svc: MediaConversionService): void =>
    (svc as unknown as { onModuleInit?: () => void }).onModuleInit?.();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(realTmp, 'owa-tmp-root-'));
    outside = fs.mkdtempSync(path.join(realTmp, 'owa-tmp-outside-'));
    gatewayTmp.mockReturnValue(root);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    gatewayTmp.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('clears an old leftover when the conversion service starts', async () => {
    const old = leftover('openwa-convert-Ab12Cd', 3 * HOUR_MS);

    start(service());
    for (let i = 0; i < 100 && fs.existsSync(old); i++) await new Promise(resolve => setTimeout(resolve, 10));

    expect(fs.existsSync(old)).toBe(false);
  });

  it('spares anything younger than twice the conversion timeout, and never less than an hour', () => {
    const sweep = jest.spyOn(ffmpeg, 'removeStaleConversionDirs').mockResolvedValue(0);

    start(service());
    start(service(2 * HOUR_MS));

    expect(sweep.mock.calls.map(([minAgeMs]) => minAgeMs)).toEqual([HOUR_MS, 4 * HOUR_MS]);
  });

  it('removes only old conversion directories, never young ones, other entries or what a link points at', async () => {
    const old = leftover('openwa-convert-Ef34Gh', 3 * HOUR_MS);
    const young = leftover('openwa-convert-Ij56Kl', 10 * 60 * 1000);
    const unrelated = leftover('openwa-other-Mn78Op', 3 * HOUR_MS);
    const file = path.join(root, 'openwa-convert-Qr90St');
    fs.writeFileSync(file, 'not a directory');
    const target = path.join(outside, 'kept');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'data'), 'kept');
    const link = path.join(root, 'openwa-convert-Uv12Wx');
    fs.symlinkSync(target, link);
    const at = new Date(Date.now() - 3 * HOUR_MS);
    fs.utimesSync(target, at, at);
    const warn = jest.fn();

    expect(await ffmpeg.removeStaleConversionDirs(HOUR_MS, warn)).toBe(1);

    expect(fs.existsSync(old)).toBe(false);
    expect([young, unrelated, file, link, path.join(target, 'data')].filter(p => !fs.existsSync(p))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a temp dir it cannot list instead of throwing', async () => {
    gatewayTmp.mockReturnValue(path.join(root, 'missing'));
    const warn = jest.fn();

    await expect(ffmpeg.removeStaleConversionDirs(HOUR_MS, warn)).resolves.toBe(0);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not list the temp dir'), expect.anything());
  });
});
