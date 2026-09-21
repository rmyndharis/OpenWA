import { TABLE_IMPORTERS } from './table-importers';

/**
 * The sessions importer is the one restore path that writes a value later used to build an on-disk
 * auth-directory path, and it bypasses CreateSessionDto. Both columns matter: the id keys the
 * directory, the name is matched against the legacy one. A row carrying a traversal in either must
 * be skipped with a reason rather than inserted.
 */
describe('sessions table importer', () => {
  const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
  const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: '0a941dac-a965-45e7-b318-74ae8be134f0',
    name: 'my-bot',
    status: 'created',
    ...overrides,
  });

  it('accepts a row whose id and name are both safe path keys', () => {
    expect(sessions?.skip?.(row({}) as never)).toBeNull();
  });

  it('skips a row whose id would traverse out of the auth directory', () => {
    expect(sessions?.skip?.(row({ id: '../../etc' }) as never)).toMatch(/unsafe id/);
  });

  it('skips a row whose name would traverse out of the auth directory', () => {
    expect(sessions?.skip?.(row({ name: '../alice' }) as never)).toMatch(/unsafe name/);
  });
});
