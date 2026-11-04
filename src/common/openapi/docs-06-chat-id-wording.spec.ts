import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The chat routes take a `chatId` in their body. The published contract describes it as the neutral
 * form the gateway returns on either engine (`<phone>@c.us`, `<lid>@lid`, `<group>@g.us`); docs/06
 * restates the same field in each route's request table, so the two must describe it the same way.
 */
describe('docs/06 describes the chat request chatId as the contract does', () => {
  const REPO = join(__dirname, '..', '..', '..');
  const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), 'utf8');

  type Schema = { $ref?: string; properties?: Record<string, { description?: string }> };
  type Operation = { requestBody?: { content?: Record<string, { schema?: Schema }> } };
  const spec = JSON.parse(read('openapi.json')) as {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, Schema> };
  };
  const doc = read('docs', '06-api-specification.md');

  /** Body routes whose request schema describes `chatId` as the neutral form. */
  const neutralChatIdRoutes = (): string[] => {
    const routes: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const ref = op.requestBody?.content?.['application/json']?.schema?.$ref;
        const schema = ref ? spec.components.schemas[ref.split('/').pop()!] : undefined;
        const description = schema?.properties?.chatId?.description ?? '';
        if (description.includes('neutral form')) {
          routes.push(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`);
        }
      }
    }
    return routes.sort();
  };

  /** The `chatId` row of a route's request table in docs/06. */
  const chatIdRow = (route: string): string => {
    const start = doc.indexOf(`\n#### ${route}\n`);
    if (start === -1) return '';
    // Past the heading's own line, so the next-heading search does not stop on it.
    const rest = doc.slice(doc.indexOf('\n', start + 1) + 1);
    const end = rest.search(/^#{2,4} /m);
    const section = end === -1 ? rest : rest.slice(0, end);
    return section.split('\n').find(line => /^\|\s*`?chatId`?\s*\|/.test(line)) ?? '';
  };

  it('finds the chat routes whose contract describes chatId as neutral', () => {
    expect(neutralChatIdRoutes().length).toBeGreaterThanOrEqual(8);
  });

  it.each(neutralChatIdRoutes())('%s does not call its chatId engine-native', route => {
    const row = chatIdRow(route);
    expect(row).not.toBe('');
    expect(row).not.toMatch(/engine-native/i);
    expect(row).not.toMatch(/@s\.whatsapp\.net` \(Baileys\)/);
  });

  it('calls no chatId row engine-native, path parameters included', () => {
    const rows = doc.split('\n').filter(line => /^\|\s*`chatId`\s*\|/.test(line));
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.filter(row => /engine-native/i.test(row))).toEqual([]);
  });
});
