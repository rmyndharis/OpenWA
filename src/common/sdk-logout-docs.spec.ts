import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A Baileys logout of a session with no linked device answers 409, and retrying it cannot help. Every SDK
 * documents its logout errors on the method; one that names only the retryable 502 sends its readers into
 * a retry of a logout that can never succeed.
 */
describe('SDK logout docs: the 409 for a session with no linked device', () => {
  const repoRoot = join(__dirname, '..', '..');
  const docblocks: [string, RegExp][] = [
    ['sdk/go/sessions.go', /\/\/ Logout [\s\S]*?func \(s \*SessionsService\) Logout/],
    ['sdk/javascript/src/resources/sessions.ts', /\/\*\*[^/]*?engine-native unlink[\s\S]*?logout\(id: string\)/],
    ['sdk/python/openwa/resources/sessions.py', /def logout[\s\S]*?"""[\s\S]*?"""/],
    ['sdk/php/src/Resources/SessionsResource.php', /\/\*\*[^/]*?engine-native unlink[\s\S]*?function logout/],
    [
      'sdk/java/src/main/java/com/rmyndharis/openwa/resources/SessionsResource.java',
      /\/\*\*[^/]*?engine-native unlink[\s\S]*?public SessionResponse logout/,
    ],
  ];

  it.each(docblocks)('%s names the 409 next to the 502', (path, docblock) => {
    const block = (readFileSync(join(repoRoot, path), 'utf8').match(docblock)?.[0] ?? '').replace(/\s+/g, ' ');
    // The logout docblock was found: it names the 502's code.
    expect(block).toContain('SESSION_LOGOUT_INCOMPLETE');
    expect(block).toMatch(/409/);
    expect(block).toContain('no linked device');
  });
});
