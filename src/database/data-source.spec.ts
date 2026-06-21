import { globSync } from 'glob';
import dataDataSource from './data-source';

// The data CLI DataSource manages the DATA connection's migrations (session/webhook/message/
// template/engine). It must NOT pull in the auth/audit entities — those belong to the always-SQLite
// MAIN connection (data-source-main.ts). A broad '**' entity glob would sweep the main-owned
// entities into `migration:generate` against the data DB and emit spurious auth/audit DDL.
describe('data CLI DataSource', () => {
  const resolveEntityFiles = (): string[] =>
    (dataDataSource.options.entities as string[])
      .flatMap(pattern => globSync(pattern))
      .map(file => file.replace(/\\/g, '/'));

  it('resolves the data-owned entities (session, webhook, message, template, engine)', () => {
    const files = resolveEntityFiles();
    expect(files.some(f => f.endsWith('session.entity.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('webhook.entity.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('message.entity.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('template.entity.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('lid-mapping.entity.ts'))).toBe(true);
  });

  it('never resolves the main-owned api-key/audit-log entities', () => {
    const files = resolveEntityFiles();
    expect(files.some(f => f.endsWith('api-key.entity.ts'))).toBe(false);
    expect(files.some(f => f.endsWith('audit-log.entity.ts'))).toBe(false);
  });

  it('does not use a catch-all entity glob (guards against re-broadening)', () => {
    for (const pattern of dataDataSource.options.entities as string[]) {
      expect(pattern).not.toMatch(/\/\.\.\/\*\*\/\*\.entity/);
    }
  });
});
