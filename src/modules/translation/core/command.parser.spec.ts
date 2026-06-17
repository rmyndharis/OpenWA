// src/modules/translation/core/command.parser.spec.ts
import { parseCommand } from './command.parser';

describe('parseCommand', () => {
  it('returns null for non-prefixed text', () => {
    expect(parseCommand('hello world', '/tr')).toBeNull();
  });

  it('parses bare commands', () => {
    expect(parseCommand('/tr on', '/tr')).toEqual({ name: 'on' });
    expect(parseCommand('/tr help', '/tr')).toEqual({ name: 'help' });
  });

  it('accepts the /translate alias and is case-insensitive on the verb', () => {
    expect(parseCommand('/translate OFF', '/tr')).toEqual({ name: 'off' });
  });

  it('parses setlang with default me target', () => {
    expect(parseCommand('/tr setlang es', '/tr')).toEqual({
      name: 'setlang',
      lang: 'es',
      target: { kind: 'me' },
    });
  });

  it('parses a number target', () => {
    expect(parseCommand('/tr grant 14155551212', '/tr')).toEqual({
      name: 'grant',
      target: { kind: 'number', number: '14155551212' },
    });
  });

  it('parses a mention target', () => {
    expect(parseCommand('/tr ignore @someone', '/tr')).toEqual({
      name: 'ignore',
      target: { kind: 'mention' },
    });
  });

  it('returns null for an unknown verb', () => {
    expect(parseCommand('/tr frobnicate', '/tr')).toBeNull();
  });
});
