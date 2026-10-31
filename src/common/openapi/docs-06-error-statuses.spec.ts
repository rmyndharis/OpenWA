import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Each route section of docs/06 lists its error statuses, and openapi.json declares them per
 * operation. A client reading either must meet the same set. The statuses the contract documents
 * once for every operation (401, 403, 413, 415, 429 and 500, plus the body-validation 400 of a route
 * that takes a body) are left out of the comparison, since neither side has to repeat them.
 */
describe('docs/06 error statuses match the published contract', () => {
  const REPO = join(__dirname, '..', '..', '..');
  const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), 'utf8');

  type Operation = { responses: Record<string, unknown>; requestBody?: unknown };
  const spec = JSON.parse(read('openapi.json')) as { paths: Record<string, Record<string, Operation>> };
  const doc = read('docs', '06-api-specification.md');

  const GATEWAY_WIDE = new Set(['401', '403', '413', '415', '429', '500']);
  const shape = (path: string): string => path.replace(/(\{\w+\}|:\w+)/g, ':*').replace(/\/+$/, '');

  const operations = new Map<string, Operation>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) operations.set(`${method.toUpperCase()} ${shape(path)}`, op);
  }

  /** Each documented route with the statuses its `**Errors:**` list names at the head of an item. */
  const documented = (): Array<[string, string[], string[]]> => {
    const heads = [...doc.matchAll(/^#### (GET|POST|PUT|PATCH|DELETE) (\S+)/gm)];
    const rows: Array<[string, string[], string[]]> = [];
    heads.forEach((head, i) => {
      const end = i + 1 < heads.length ? heads[i + 1].index : doc.length;
      const section = doc.slice(head.index + head[0].length, end);
      const op = operations.get(`${head[1]} ${shape(head[2])}`);
      const errors = /\*\*Errors?:?\*\*:?([\s\S]*?)(?:\n\n|$)/.exec(section);
      if (!op || !errors) return;
      const items = errors[1].trim();
      const listed = new Set([...items.matchAll(/(?:^|·)\s*`(\d{3})`/g)].map(m => m[1]));
      const ignored = new Set(GATEWAY_WIDE);
      if (op.requestBody) ignored.add('400');
      const declared = Object.keys(op.responses).filter(status => !status.startsWith('2'));
      const docOnly = [...listed].filter(status => !ignored.has(status) && !declared.includes(status)).sort();
      const contractOnly = declared.filter(status => !ignored.has(status) && !listed.has(status)).sort();
      rows.push([`${head[1]} ${head[2]}`, docOnly, contractOnly]);
    });
    return rows;
  };

  it('compares a plausible number of routes', () => {
    expect(documented().length).toBeGreaterThan(150);
  });

  it.each(documented())('%s lists the statuses the contract declares', (_route, docOnly, contractOnly) => {
    expect({ docOnly, contractOnly }).toEqual({ docOnly: [], contractOnly: [] });
  });
});
