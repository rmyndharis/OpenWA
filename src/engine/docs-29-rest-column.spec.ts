import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * docs/29 §29.4's REST column says what a REST caller gets for each interface method. A method no
 * route reaches is `⚙️ internal`; one marked ✅ or ⚠️ must be called from code the HTTP, MCP or event
 * surface runs, not only from the plugin capability bridge, which no REST route reaches.
 *
 * Calls are matched by name, so a same-named call on an unrelated object also counts: this catches a method
 * nothing calls at all, not one whose only call goes to another object.
 */
describe('docs/29 REST column names only methods a route can reach', () => {
  const root = join(__dirname, '..', '..');
  const doc = readFileSync(join(root, 'docs', '29-engine-capability-matrix.md'), 'utf8');
  const contract = doc.slice(doc.indexOf('## 29.4 '), doc.indexOf('## 29.5 '));

  const sources: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts'))
        sources[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(join(root, 'src'));

  // The engine implements the methods and the plugin bridge forwards them; neither is a route.
  const excluded = (path: string): boolean =>
    path.startsWith(join('src', 'engine', 'adapters')) ||
    path.startsWith(join('src', 'engine', 'interfaces')) ||
    path.startsWith(join('src', 'core', 'plugins')) ||
    path.endsWith('engine-capability-matrix.ts');

  const rows = [...contract.matchAll(/^\| `([a-zA-Z]+)`\s*\|[^|]*\|[^|]*\|([^|]*)\|/gm)].map(m => ({
    method: m[1],
    rest: m[2].trim(),
  }));

  it('reads the §29.4 rows', () => {
    expect(rows.length).toBeGreaterThan(100);
  });

  it('marks a method no route calls as internal', () => {
    const unreachable = rows
      .filter(row => row.rest.startsWith('✅') || row.rest.startsWith('⚠️'))
      // The two store-backed status reads are served by the status store, which the row says.
      .filter(row => !row.rest.includes('(store)'))
      .filter(
        row =>
          !Object.entries(sources).some(
            ([path, text]) => !excluded(path) && new RegExp(String.raw`\.${row.method}\(`).test(text),
          ),
      )
      .map(row => `${row.method} (${row.rest})`);
    expect(unreachable).toEqual([]);
  });
});
