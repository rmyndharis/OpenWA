import * as path from 'path';
import { isPathWithin, isSafeStorageKey, isSafeSessionName } from './path-safety';

describe('isPathWithin', () => {
  const root = path.resolve('/srv/app/data');

  it('allows a normal nested path', () => {
    expect(isPathWithin(root, 'media/file.jpg')).toBe(true);
  });

  it('allows the root itself', () => {
    expect(isPathWithin(root, '.')).toBe(true);
  });

  it('blocks parent traversal via ".."', () => {
    expect(isPathWithin(root, '../../etc/passwd')).toBe(false);
  });

  it('blocks an absolute path outside the root', () => {
    expect(isPathWithin(root, '/etc/passwd')).toBe(false);
  });

  it('blocks a sibling directory that shares the root prefix', () => {
    // "/srv/app/data-evil" must NOT be considered inside "/srv/app/data"
    expect(isPathWithin('/srv/app/data', '/srv/app/data-evil/x')).toBe(false);
  });
});

describe('isSafeStorageKey', () => {
  it.each([
    'file.jpg',
    'sessionId/messageId.jpg',
    'a/b/c.txt',
    'group:sid:123@g.us.json', // plugin/JID-style keys must survive (':' '@' '.' '-')
  ])('accepts the safe relative key %s', k => {
    expect(isSafeStorageKey(k)).toBe(true);
  });

  it.each([
    '../evil.txt',
    'a/../../etc/passwd',
    'media/../../../secret',
    '/etc/passwd', // absolute
    '..',
    'a\\..\\b', // backslash traversal (pins the split on '\\' too)
    '', // empty
  ])('rejects the traversing/absolute key %j', k => {
    expect(isSafeStorageKey(k)).toBe(false);
  });

  it('rejects a key containing a NUL or other control character (it reaches the raw S3 object key)', () => {
    expect(isSafeStorageKey(`foo${String.fromCharCode(0)}.txt`)).toBe(false); // NUL
    expect(isSafeStorageKey(`bar${String.fromCharCode(9)}.txt`)).toBe(false); // tab
    expect(isSafeStorageKey(`baz${String.fromCharCode(31)}.txt`)).toBe(false); // unit separator
  });
});

describe('isSafeSessionName', () => {
  it.each(['my-session', 'Session1', 'abc', 'A-B-2'])('accepts the safe name %j', n => {
    expect(isSafeSessionName(n)).toBe(true);
  });

  it.each([
    '../../etc', // traversal
    'a/b', // slash
    'a\\b', // backslash
    'a.b', // dot (would traverse / change the auth dir)
    'has space',
    'name@x',
    '', // empty
    undefined,
    null,
    123,
  ])('rejects the unsafe name %j', n => {
    expect(isSafeSessionName(n as unknown)).toBe(false);
  });
});
