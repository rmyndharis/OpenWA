import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { LoggerService } from '../../common/services/logger.service';
import {
  capToolError,
  handleToolError,
  INLINE_RESULT_MAX_BYTES,
  readMaxResultBytes,
  smartToolResult,
  TOOL_ERROR_TEXT_MAX_CHARS,
} from './tool-result';

describe('smartToolResult', () => {
  it('inlines a small object as JSON text', () => {
    expect(smartToolResult({ id: 1 }).content).toEqual([{ type: 'text', text: '{"id":1}' }]);
  });

  it('passes a string payload through as plain text', () => {
    expect(smartToolResult('done').content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('survives an undefined handler result instead of throwing after the write ran', () => {
    // JSON.stringify(undefined) is undefined; reading .length off it threw a TypeError that
    // handleToolError then reported as `Internal error` for an operation that had succeeded.
    const result = smartToolResult(undefined as unknown as object);
    expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
  });

  // The threshold is in UTF-8 bytes, not UTF-16 code units: multi-byte text must not inline at triple size.
  const limit = INLINE_RESULT_MAX_BYTES;
  it.each(['x'.repeat(limit), '\u00e9'.repeat(limit / 2), '\ud83d\ude00'.repeat(limit / 4)])(
    'inlines a payload of exactly the limit in UTF-8 bytes',
    text => {
      expect(Buffer.byteLength(text)).toBe(limit);
      expect(smartToolResult(text).content).toEqual([{ type: 'text', text }]);
    },
  );

  it.each([
    'x'.repeat(limit + 1),
    '\u00e9'.repeat(limit / 2) + 'x',
    '\u4e2d'.repeat(Math.ceil((limit + 1) / 3)),
    '\ud83d\ude00'.repeat(limit / 4 + 1),
  ])('embeds a payload over the limit without changing its contents', text => {
    expect(Buffer.byteLength(text)).toBeGreaterThan(limit);
    const { content } = smartToolResult(text);
    expect(content).toHaveLength(2);
    const resource = content[1];
    if (resource.type !== 'resource' || !('blob' in resource.resource)) throw new Error('expected a blob resource');
    expect(Buffer.from(resource.resource.blob, 'base64').toString('utf8')).toBe(text);
  });

  it('returns a result of about 4.5 KB, the size of sixteen sessions, as text', () => {
    // The client-side file Claude Code writes for an offloaded blob is the only way the model reaches the data.
    const rows = Array.from({ length: 16 }, (_, i) => ({
      id: `${i}`.padStart(36, '0'),
      name: `probe-${i}`,
      note: 'x'.repeat(240),
    }));
    const result = smartToolResult(rows);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(4096);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(rows) }]);
  });

  it('offloads a payload over the limit to an embedded resource', () => {
    const big = { blob: 'x'.repeat(limit + 1000) };
    const result = smartToolResult(big);
    expect(result.content).toHaveLength(2);
    const [pointer, resource] = result.content;
    if (pointer.type !== 'text') throw new Error('expected a text pointer');
    expect(pointer.text).toMatch(/^Received resource mcp:\/\/toolResult\/.+\.json with \d+ bytes$/);
    expect(resource).toMatchObject({ type: 'resource', resource: { mimeType: 'application/json' } });
  });
});

describe('handleToolError logging', () => {
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs a client-caused 4xx at warn without a stack, as REST leaves it unlogged', () => {
    handleToolError(new NotFoundException('Session x not found'));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('MCP tool error 404: Session x not found');
  });

  it('keeps a 5xx at error with its stack', () => {
    const failure = new ServiceUnavailableException('engine down');
    handleToolError(failure);
    expect(error).toHaveBeenCalledWith('engine down', failure.stack);
    expect(warn).not.toHaveBeenCalled();
  });
});

// A tool takes ids from the caller, and the services name them in their refusals ("Webhook with id '...' not
// found", "... is not a group id"). REST bounds what such an id can be through the request line; a tool call
// arrives in a body of up to BODY_SIZE_LIMIT, so the error carries the id back only up to a cap.
describe('handleToolError text cap', () => {
  const CAP = TOOL_ERROR_TEXT_MAX_CHARS;
  const body = (result: ReturnType<typeof handleToolError>): { success: boolean; name: string; message: unknown } => {
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('expected a text block');
    return JSON.parse(first.text) as { success: boolean; name: string; message: unknown };
  };
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('caps a client-supplied id in the answer and in the log line, and says it did', () => {
    const id = 'x'.repeat(2_000_000);
    const result = handleToolError(new NotFoundException(`Webhook with id '${id}' not found`));

    const { message, name, success } = body(result);
    expect(success).toBe(false);
    expect(name).toBe('NotFoundException');
    expect(result.isError).toBe(true);
    expect(typeof message).toBe('string');
    expect((message as string).length).toBeLessThan(CAP + 100);
    expect(message as string).toMatch(/^Webhook with id 'x{100}/);
    expect(message as string).toContain(
      `[truncated, ${2_000_000 + "Webhook with id '' not found".length} characters in all]`,
    );

    const [logged] = warn.mock.calls[0] as [string];
    expect(logged.startsWith('MCP tool error 404: Webhook with id')).toBe(true);
    expect(logged.length).toBeLessThan(CAP + 150);
  });

  it('leaves a message of exactly the cap whole', () => {
    const text = 'y'.repeat(CAP);
    expect(body(handleToolError(new BadRequestException(text))).message).toBe(text);
    expect(warn).toHaveBeenCalledWith(`MCP tool error 400: ${text}`);
  });

  it('caps each entry of a message list and keeps a short entry as it was', () => {
    const { message } = body(handleToolError(new BadRequestException(['limit: too big', 'z'.repeat(CAP + 1)])));
    expect(Array.isArray(message)).toBe(true);
    const [short, long] = message as string[];
    expect(short).toBe('limit: too big');
    expect(long.length).toBeLessThan(CAP + 100);
    expect(long).toContain('[truncated, ');
  });

  it('caps the answer and the log line of a 5xx, and keeps the frames of its stack', () => {
    const id = 'w'.repeat(500_000);
    const failure = new ServiceUnavailableException(`engine said ${id}`);
    const result = handleToolError(failure);

    expect((body(result).message as string).length).toBeLessThan(CAP + 100);
    const [line, stack] = error.mock.calls[0] as [string, string];
    expect(line.length).toBeLessThan(CAP + 100);
    expect(stack.length).toBeLessThan(CAP * 5);
    expect(stack).toContain('at ');
  });

  it('answers an internal error generically and caps the message in what it logs, stack included', () => {
    const failure = new Error(`invalid input syntax for type uuid: "${'v'.repeat(300_000)}"`);
    expect(failure.stack).toContain('v'.repeat(1000)); // the echo really is in the stack
    const result = handleToolError(failure);

    expect(body(result).message).toBe('Internal error');
    const [line, stack] = error.mock.calls[0] as [string, string];
    expect(line.length).toBeLessThan(CAP + 100);
    expect(stack.length).toBeLessThan(CAP * 5);
    expect(stack).toContain('[truncated, ');
    expect(stack).toContain('at ');
  });

  it('still answers and logs an error whose message or stack is not a string', () => {
    const odd = (message: unknown, stack: unknown): Error => {
      const failure = new Error('x');
      Object.defineProperty(failure, 'message', { value: message });
      Object.defineProperty(failure, 'stack', { value: stack });
      return failure;
    };

    for (const failure of [odd(undefined, 'Error\n    at frame'), odd(42, undefined), odd('plain', 7)]) {
      error.mockClear();
      const result = handleToolError(failure);

      expect(body(result).message).toBe('Internal error');
      expect(error).toHaveBeenCalledTimes(1);
    }
  });

  it('does not expand a replacement pattern that the cut message happens to hold', () => {
    // `$&` in a replacement STRING stands for the matched text, which here is the whole 10000 characters.
    const failure = new Error('$&'.repeat(5000));
    handleToolError(failure);
    const [, stack] = error.mock.calls[0] as [string, string];
    expect(stack).toContain('$&'.repeat(CAP / 2) + '... [truncated, 10000 characters in all]');
    expect(stack.length).toBeLessThan(CAP * 5);
    expect(stack).toContain('at ');
  });

  it('does not cut a surrogate pair in half', () => {
    const emoji = '😀';
    const { message } = body(handleToolError(new BadRequestException('a'.repeat(CAP - 1) + emoji + 'tail')));
    const kept = (message as string).slice(0, (message as string).indexOf('... [truncated'));
    expect(kept).toBe('a'.repeat(CAP - 1));
    expect(/[\ud800-\udbff]$/.test(kept)).toBe(false);
  });

  it('leaves a short message and its log line exactly as before', () => {
    expect(body(handleToolError(new NotFoundException('Session x not found'))).message).toBe('Session x not found');
    expect(warn).toHaveBeenCalledWith('MCP tool error 404: Session x not found');
  });
});

describe('handleToolError code', () => {
  const answer = (error: unknown) =>
    JSON.parse((handleToolError(error).content[0] as { text: string }).text) as Record<string, unknown>;
  beforeEach(() => jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('carries the code of an HTTP error that has one, so an agent can branch on it', () => {
    const error = new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'A request with this Idempotency-Key is still running.',
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });

    expect(answer(error)).toEqual({
      success: false,
      name: 'ConflictException',
      message: 'A request with this Idempotency-Key is still running.',
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });
  });

  it.each([undefined, 7, null, ''])('adds no code when the error carries %p', code => {
    const body = answer(new BadRequestException({ statusCode: 400, message: 'nope', code }));

    expect(body).toEqual({ success: false, name: 'BadRequestException', message: 'nope' });
  });

  it('adds no code to an error without a body object', () => {
    expect(answer(new NotFoundException('Session x not found'))).toEqual({
      success: false,
      name: 'NotFoundException',
      message: 'Session x not found',
    });
  });

  it('bounds a code that is not a short token', () => {
    const body = answer(new BadRequestException({ message: 'nope', code: 'x'.repeat(500) }));

    expect(body.code).toBe('x'.repeat(64));
  });

  // The interval a REST answer names (the page reload 409, the send pacing 429) is how long an agent should wait.
  it('carries the retryAfterSeconds of an HTTP error that has one, beside its code', () => {
    const error = new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'WhatsApp Web is reloading its page.',
      code: 'ENGINE_PAGE_RELOADING',
      retryAfterSeconds: 5,
    });

    expect(answer(error)).toEqual({
      success: false,
      name: 'ConflictException',
      message: 'WhatsApp Web is reloading its page.',
      code: 'ENGINE_PAGE_RELOADING',
      retryAfterSeconds: 5,
    });
  });

  it('carries a retryAfterSeconds of zero', () => {
    expect(answer(new ConflictException({ message: 'wait', retryAfterSeconds: 0 })).retryAfterSeconds).toBe(0);
  });

  it.each(['5', -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}])(
    'adds no retryAfterSeconds when the error carries %p',
    retryAfterSeconds => {
      const body = answer(new ConflictException({ message: 'wait', retryAfterSeconds }));

      expect(body).not.toHaveProperty('retryAfterSeconds');
    },
  );
});

describe('smartToolResult with MCP_MAX_RESULT_BYTES (an opt-in cap that makes every result text)', () => {
  const note = (total: number): string =>
    `\n…[truncated: ${total} bytes in all; ` +
    'narrow the request, with limit and offset where the tool takes them, to see the rest]';
  const blobOf = (result: ReturnType<typeof smartToolResult>): string => {
    const resource = result.content[1];
    if (resource?.type !== 'resource' || !('blob' in resource.resource)) throw new Error('expected a blob resource');
    return Buffer.from(resource.resource.blob, 'base64').toString('utf8');
  };
  const big = 'x'.repeat(233 * 1000);

  it.each([undefined, 0])('is unchanged when the cap is %s: a 233 KB payload still becomes the blob', cap => {
    const result = cap === undefined ? smartToolResult(big) : smartToolResult(big, cap);
    expect(result.content).toHaveLength(2);
    expect((result.content[0] as { text: string }).text).toContain(`with ${big.length} bytes`);
    expect(blobOf(result)).toBe(big);
  });

  it('truncates a 233 KB payload at a cap of 100000, with the note and the byte count', () => {
    const result = smartToolResult(big, 100000);
    expect(result.content).toEqual([{ type: 'text', text: 'x'.repeat(100000) + note(233000) }]);
  });

  it('counts the cut in UTF-8 bytes of the serialized payload, for an object too', () => {
    const data = { rows: 'y'.repeat(5000) };
    const total = Buffer.byteLength(JSON.stringify(data));
    const result = smartToolResult(data, 1000);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(data).slice(0, 1000) + note(total) }]);
  });

  it('never splits a multi-byte character at the cut', () => {
    // 3-byte characters: a cap of 100000 falls one byte into the 33334th, so the cut backs up to 99999.
    const euro = '\u20ac'.repeat(80000);
    const t3 = smartToolResult(euro, 100000).content[0];
    expect(t3).toEqual({ type: 'text', text: '\u20ac'.repeat(33333) + note(240000) });
    // 4-byte characters, and a 2-byte one, at every offset into a character.
    const emoji = '\ud83d\ude00'.repeat(100);
    for (const [cap, kept] of [
      [10, 2],
      [11, 2],
      [12, 3],
      [13, 3],
      [3, 0],
      [4, 1],
    ] as const) {
      expect(smartToolResult(emoji, cap).content).toEqual([
        { type: 'text', text: '\ud83d\ude00'.repeat(kept) + note(400) },
      ]);
    }
    const e = smartToolResult('\u00e9'.repeat(1000), 5).content[0];
    expect(e).toEqual({ type: 'text', text: '\u00e9\u00e9' + note(2000) });
    for (const cap of [1, 2, 3, 4, 5, 6, 7]) {
      const text = (smartToolResult(euro, cap).content[0] as { text: string }).text;
      expect(text).not.toContain('\ufffd');
    }
  });

  it('does not truncate a payload exactly at the cap, and does at one byte over', () => {
    const atCap = 'x'.repeat(40000); // over the 32 KB inline limit: text all the same, because a cap is set
    expect(smartToolResult(atCap, 40000).content).toEqual([{ type: 'text', text: atCap }]);
    expect(smartToolResult(atCap + 'x', 40000).content).toEqual([{ type: 'text', text: atCap + note(40001) }]);
    const small = 'x'.repeat(100);
    expect(smartToolResult(small, 100).content).toEqual([{ type: 'text', text: small }]);
  });

  // The blob of a payload under the cap is that payload in base64, a third larger: 120 kB under a 150000 cap would
  // reach the client as 160000 characters. And a client that shows the model text alone would show it none of it.
  it('returns text, never the blob, for a payload between the inline limit and the cap', () => {
    const mid = 'x'.repeat(50000);
    expect(smartToolResult(mid, 100000).content).toEqual([{ type: 'text', text: mid }]);
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `chat-${i}`, name: 'n'.repeat(80) }));
    const json = JSON.stringify(rows);
    expect(Buffer.byteLength(json)).toBeGreaterThan(INLINE_RESULT_MAX_BYTES);
    expect(smartToolResult(rows, 150000).content).toEqual([{ type: 'text', text: json }]);
  });

  it('checks the cap first, so a cap below the inline limit truncates a payload that would have been text', () => {
    const text = 'x'.repeat(5000);
    expect(smartToolResult(text, 1000).content).toEqual([{ type: 'text', text: 'x'.repeat(1000) + note(5000) }]);
    expect(smartToolResult(text).content).toEqual([{ type: 'text', text }]);
  });
});

describe('readMaxResultBytes', () => {
  it.each([undefined, '', ' ', '0', '-5', '1.5', '100k', 'abc', '1e5'])('reads %p as no cap', raw => {
    expect(readMaxResultBytes({ MCP_MAX_RESULT_BYTES: raw })).toBe(0);
  });

  it('reads a positive decimal integer', () => {
    expect(readMaxResultBytes({ MCP_MAX_RESULT_BYTES: '100000' })).toBe(100000);
    expect(readMaxResultBytes({ MCP_MAX_RESULT_BYTES: ' 100000 ' })).toBe(100000);
  });

  // Read as no cap, such a value would hand the client the base64 resource the operator set a cap to avoid.
  it.each(['9007199254740993', '99999999999999999999', '9'.repeat(400)])(
    'reads a count past what a number holds exactly (%p) as a cap no result reaches',
    raw => {
      const cap = readMaxResultBytes({ MCP_MAX_RESULT_BYTES: raw });
      expect(cap).toBe(Number.MAX_SAFE_INTEGER);
      expect(smartToolResult({ rows: 'x'.repeat(INLINE_RESULT_MAX_BYTES * 2) }, cap).content).toHaveLength(1);
    },
  );

  it('reads process.env by default', () => {
    const prev = process.env.MCP_MAX_RESULT_BYTES;
    try {
      process.env.MCP_MAX_RESULT_BYTES = '2048';
      expect(readMaxResultBytes()).toBe(2048);
      delete process.env.MCP_MAX_RESULT_BYTES;
      expect(readMaxResultBytes()).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.MCP_MAX_RESULT_BYTES;
      else process.env.MCP_MAX_RESULT_BYTES = prev;
    }
  });
});

describe('capToolError', () => {
  const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

  it('leaves an error answer alone without a cap, and one that fits under it', () => {
    const long = refusal('x'.repeat(5000));
    expect(capToolError(long, 0)).toBe(long);
    expect(capToolError(refusal('short'), 1000)).toEqual(refusal('short'));
  });

  it('cuts an error answer past the cap at a character boundary, keeps it an error, and gives no paging advice', () => {
    const cut = capToolError(refusal('\u00e9'.repeat(3000)), 1001);
    expect(cut.isError).toBe(true);
    // 1001 falls inside a two-byte character, so the cut steps back to 1000 bytes: 500 whole characters.
    expect(cut.content).toEqual([
      { type: 'text', text: `${'\u00e9'.repeat(500)}\n\u2026[truncated: 6000 bytes in all]` },
    ]);
  });

  it('cuts the list of messages a service refuses a wide input with', () => {
    const messages = Array.from({ length: 400 }, (_, i) => `vars.v${i} must be a string`);
    const answer = handleToolError(new BadRequestException(messages));
    const whole = Buffer.byteLength((answer.content[0] as { text: string }).text);
    expect(whole).toBeGreaterThan(2000);
    const text = (capToolError(answer, 2000).content[0] as { text: string }).text;
    expect(Buffer.byteLength(text.split('\n\u2026')[0])).toBe(2000);
    expect(text.endsWith(`[truncated: ${whole} bytes in all]`)).toBe(true);
  });
});
