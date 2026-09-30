import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * docs/10 once carried a hand-written full Dockerfile that drifted from the real one: a bare
 * `npm ci` in the builder, `npm ci --only=production` without the patchers, and a CMD that no image
 * built from it could start. The docs now quote an excerpt, and this keeps every quoted directive
 * present in the real Dockerfile, so the excerpt cannot drift the same way.
 */
describe('docs/10 Dockerfile excerpt matches the Dockerfile', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8');

  /** Code lines of every ```dockerfile fence in the "### Dockerfile" section, comments dropped. */
  const quotedDirectives = (): string[] => {
    const doc = read('docs', '10-devops-infrastructure.md');
    const start = doc.indexOf('### Dockerfile\n');
    const section = doc.slice(start, doc.indexOf('\n### ', start + 1));
    return [...section.matchAll(/```dockerfile\n([\s\S]*?)```/g)]
      .flatMap(fence => fence[1].split('\n'))
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'));
  };

  it('quotes only lines the Dockerfile actually contains', () => {
    const quoted = quotedDirectives();
    // Guard the parser: an excerpt that scanned to nothing would pass vacuously.
    expect(quoted.length).toBeGreaterThan(5);
    const dockerfile = new Set(
      read('Dockerfile')
        .split('\n')
        .map(line => line.trim()),
    );
    expect(quoted.filter(line => !dockerfile.has(line))).toEqual([]);
  });

  it('never prescribes the stale install or health probe forms', () => {
    for (const doc of ['10-devops-infrastructure.md', '12-troubleshooting-faq.md']) {
      const text = read('docs', doc);
      expect(text).not.toContain('npm ci --only=production');
      // The probe targets readiness, as the image and both compose files do, not the bare /api/health.
      expect(text).not.toMatch(/localhost:2785\/api\/health(?:'|"| \|\|)/);
    }
  });
});
