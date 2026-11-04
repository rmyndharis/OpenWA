import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';
import { CreateSessionDto } from './create-session.dto';
import { MAX_SESSION_CONFIG_BYTES } from './recognised-session-config.validator';

/**
 * Only three keys of a session's `config` are ever read; the rest is stored but ignored, and every session read
 * (the list of up to 1000 rows, each session route, boot auto-start and the takeover sweep) loads and parses the
 * whole column. A create body therefore must not be able to park an arbitrarily large blob there.
 */
describe('POST /sessions config size', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const validate = (body: unknown): Promise<CreateSessionDto> =>
    pipe.transform(body, { type: 'body', metatype: CreateSessionDto, data: '' }) as Promise<CreateSessionDto>;
  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

  /** A config of exactly `size` bytes of JSON, made of one unrecognised key. */
  const configOf = (size: number, filler = 'x'): Record<string, string> => {
    const overhead = bytes({ note: '' });
    return { note: filler.repeat((size - overhead) / Buffer.byteLength(filler)) };
  };

  it('accepts a small config with the recognised keys', async () => {
    await expect(
      validate({ name: 'small-config', config: { autoRejectCalls: true, maxReconnectAttempts: 5 } }),
    ).resolves.toBeDefined();
  });

  it('accepts every documented key at its maximum, far below the bound', async () => {
    const largest = { autoRejectCalls: false, maxReconnectAttempts: 20, reconnectBaseDelay: 300_000 };

    await expect(validate({ name: 'largest-config', config: largest })).resolves.toBeDefined();
    expect(MAX_SESSION_CONFIG_BYTES).toBeGreaterThanOrEqual(4 * bytes(largest));
    expect(MAX_SESSION_CONFIG_BYTES).toBeGreaterThanOrEqual(16 * 1024);
  });

  it('keeps unrecognised keys below the bound exactly as sent', async () => {
    const dto = await validate({
      name: 'operator-keys',
      config: { autoRejectCalls: 'true', operatorNote: { a: [1, 2] } },
    });

    expect(dto.config).toEqual({ autoRejectCalls: true, operatorNote: { a: [1, 2] } });
  });

  it('accepts a config of exactly the bound', async () => {
    const config = configOf(MAX_SESSION_CONFIG_BYTES);
    expect(bytes(config)).toBe(MAX_SESSION_CONFIG_BYTES);

    await expect(validate({ name: 'at-the-bound', config })).resolves.toBeDefined();
  });

  it('refuses a config one byte over the bound with a 400 that names the limit', async () => {
    const config = configOf(MAX_SESSION_CONFIG_BYTES + 1);
    expect(bytes(config)).toBe(MAX_SESSION_CONFIG_BYTES + 1);

    const error = await validate({ name: 'over-the-bound', config }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((error as BadRequestException).getResponse())).toContain(String(MAX_SESSION_CONFIG_BYTES));
  });

  it('counts bytes, not characters', async () => {
    // Two bytes a character: half the bound in characters, over it in bytes.
    const config = configOf(MAX_SESSION_CONFIG_BYTES + 3, String.fromCharCode(0xe9));
    expect(JSON.stringify(config).length).toBeLessThan(MAX_SESSION_CONFIG_BYTES);

    await expect(validate({ name: 'wide-characters', config })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a config of several megabytes of unrecognised keys', async () => {
    const junk: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) junk[`k${i}`] = 'x'.repeat(1000);
    expect(bytes(junk)).toBeGreaterThan(2_000_000);

    await expect(validate({ name: 'large-config', config: junk })).rejects.toThrow();
  });

  it('refuses a config over the bound that also carries the recognised keys', async () => {
    const config = { autoRejectCalls: false, ...configOf(2 * MAX_SESSION_CONFIG_BYTES) };

    await expect(validate({ name: 'big-with-keys', config })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still reports a recognised key outside its range', async () => {
    const error = await validate({ name: 'bad-range', config: { maxReconnectAttempts: 50 } }).catch((e: unknown) => e);

    expect(JSON.stringify((error as BadRequestException).getResponse())).toContain('config.maxReconnectAttempts');
  });
});
