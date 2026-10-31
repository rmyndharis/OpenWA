import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEND_503 } from './openapi/engine-status-responses';

/**
 * Every SDK explains which 503 proves nothing was sent, because that decides whether a keyed send's
 * Idempotency-Key was freed for a retry. Besides a WhatsApp throttle, the gateway documents a send whose
 * recipient lookup failed, whose connection closed before the write, or whose media could not be fetched
 * through the session proxy as nothing-sent with the key freed. Each SDK text has to name the closed
 * connection and must not present the throttle as the only such 503.
 */
const root = join(__dirname, '..', '..');

const SDK_503_TEXTS = [
  'sdk/go/README.md',
  'sdk/go/errors.go',
  'sdk/java/README.md',
  'sdk/java/src/main/java/com/rmyndharis/openwa/errors/OpenWAServiceUnavailableError.java',
  'sdk/php/README.md',
  'sdk/php/src/Exceptions/OpenWAServiceUnavailableException.php',
  'sdk/javascript/README.md',
  'sdk/javascript/src/errors.ts',
  'sdk/python/README.md',
  'sdk/python/openwa/errors.py',
  'docs/18-sdk-design.md',
];

/** The prose of a file with comment markers and line breaks folded away, so a sentence can wrap anywhere. */
function prose(file: string): string {
  return readFileSync(join(root, file), 'utf8')
    .split('\n')
    .map(line => line.replace(/^\s*(\/\/|\/\*\*|\*\/|\*|#)?\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('SDK text on the 503s that prove nothing was sent', () => {
  it('the gateway frees a keyed send for a connection that closed before the write', () => {
    expect(SEND_503).toMatch(
      /connection closes before the message is written \(nothing was sent, and a keyed send frees/,
    );
  });

  it.each(SDK_503_TEXTS)('%s names the closed connection among them', file => {
    expect(prose(file)).toMatch(/connection (?:that )?closed before the message was written/i);
  });

  it.each(SDK_503_TEXTS)('%s does not present the throttle as the only one', file => {
    expect(prose(file)).not.toMatch(/A throttle on a send or a single write is the exception/);
  });
});
