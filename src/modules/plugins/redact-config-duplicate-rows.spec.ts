import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';
import { restoreSecretConfig, SECRET_SENTINEL } from './redact-config';

const schema: PluginConfigSchema = {
  type: 'object',
  properties: {
    endpoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: { url: { type: 'string' }, token: { type: 'string', secret: true } },
      },
    },
  },
};

// Two stored rows that differ only by their secret, a unique row after them and one more.
const stored = [
  { url: 'a', token: 's1' },
  { url: 'a', token: 's2' },
  { url: 'x', token: 'sx' },
  { url: 'c', token: 'sc' },
];

const masked = (url: string): Record<string, unknown> => ({ url, token: SECRET_SENTINEL });

const save = (rows: Array<Record<string, unknown>>): string[] =>
  (
    restoreSecretConfig({ endpoints: rows }, { endpoints: stored }, schema).endpoints as Array<{
      url: string;
      token?: string;
    }>
  ).map(row => `${row.url}:${row.token ?? '-'}`);

/**
 * Rows that are the same in every field but the secret cannot be told apart by content, so they keep their secrets
 * in the order they were stored. A row moved ahead of them must not shift a secret that belongs to another row onto one.
 */
describe('restoreSecretConfig: rows that differ only by their secret', () => {
  it('keeps every secret where it was when nothing moves', () => {
    expect(save([masked('a'), masked('a'), masked('x'), masked('c')])).toEqual(['a:s1', 'a:s2', 'x:sx', 'c:sc']);
  });

  it('gives the duplicates their own secrets when a unique row moves ahead of them', () => {
    expect(save([masked('x'), masked('a'), masked('a'), masked('c2')])).toEqual(['x:sx', 'a:s1', 'a:s2', 'c2:-']);
  });

  it('gives the duplicates their own secrets when a unique row moves behind them', () => {
    expect(save([masked('a'), masked('a'), masked('c'), masked('x')])).toEqual(['a:s1', 'a:s2', 'c:sc', 'x:sx']);
  });

  it('still binds a duplicate that was renamed in place to the secret at its position', () => {
    expect(save([masked('a'), masked('a2'), masked('x'), masked('c')])).toEqual(['a:s1', 'a2:s2', 'x:sx', 'c:sc']);
  });
});
