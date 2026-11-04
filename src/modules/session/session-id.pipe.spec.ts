import { BadRequestException, NotFoundException, ParseUUIDPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MAX_SESSION_ID_LENGTH, SessionIdPipe, sessionNotFound } from './session-id.pipe';

describe('SessionIdPipe', () => {
  const pipe = new SessionIdPipe();

  it.each([
    ['a UUID', randomUUID()],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['a restored key', 'sales-bot'],
    ['one character', 'A'],
    ['digits only', '0123456789'],
    ['the longest id', 'a'.repeat(MAX_SESSION_ID_LENGTH)],
  ])('accepts %s unchanged', (_label, id) => {
    expect(pipe.transform(id)).toBe(id);
  });

  it.each([
    ['one character past the cap', 'a'.repeat(MAX_SESSION_ID_LENGTH + 1)],
    ['an empty id', ''],
    ['a dot', 'a.b'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a parent segment', '..'],
    ['a decoded traversal', '../etc/passwd'],
    ['a percent sign', '%2e%2e'],
    ['a space', 'a b'],
    ['an underscore', 'a_b'],
    ['a non-ASCII letter', `caf${String.fromCharCode(0xe9)}`],
    ['a NUL byte', 'a\0b'],
    ['a trailing newline', 'abc\n'],
  ])('refuses %s with a 400 that names the rule', (_label, id) => {
    let thrown: unknown;
    try {
      pipe.transform(id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getStatus()).toBe(400);
    expect((thrown as BadRequestException).message).toContain('letters, digits and hyphens');
    expect((thrown as BadRequestException).message).toContain(String(MAX_SESSION_ID_LENGTH));
  });

  // The routes used to take only UUIDs; every id they accepted has to keep working.
  it('accepts every id ParseUUIDPipe accepts, whatever the UUID version', async () => {
    const uuidPipe = new ParseUUIDPipe();
    const metadata = { type: 'param' as const, data: 'sessionId' };
    const ids: string[] = ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
    for (let version = 1; version <= 8; version++) {
      const generated = randomUUID().split('');
      generated[14] = String(version);
      for (const variant of ['8', '9', 'a', 'b']) {
        generated[19] = variant;
        ids.push(generated.join(''), generated.join('').toUpperCase());
      }
    }
    for (const id of ids) {
      await expect(uuidPipe.transform(id, metadata)).resolves.toBe(id);
      expect(pipe.transform(id)).toBe(id);
    }
  });
});

describe('sessionNotFound', () => {
  it('keeps the text of a UUID id as it was', () => {
    const id = randomUUID();
    const error = sessionNotFound(id);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe(`Session with id '${id}' not found`);
  });

  it('tells a caller who sent a session name that the routes take the id', () => {
    const error = sessionNotFound('my-bot');
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe("Session with id 'my-bot' not found; session routes take the session id, not its name");
  });
});
