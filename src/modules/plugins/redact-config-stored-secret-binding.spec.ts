import { BadRequestException } from '@nestjs/common';
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

type Row = Record<string, unknown>;

const mask = (url: string): Row => ({ url, token: SECRET_SENTINEL });
// What the dashboard sends for a row added in the form: no secret key.
const added = (url: string): Row => ({ url });

const rowsOf = (stored: Row[], saved: Row[]): Array<{ url: string; token?: string }> =>
  restoreSecretConfig({ endpoints: saved }, { endpoints: stored }, schema).endpoints as Array<{
    url: string;
    token?: string;
  }>;
const save = (stored: Row[], saved: Row[]): string[] =>
  rowsOf(stored, saved).map(row => `${row.url}:${row.token ?? '-'}`);

/**
 * A stored secret belongs to the one row it was saved with. Rows that are the same in every field but the secret cannot
 * be told apart by content, and a row whose secret was cleared or typed over is still the row it came from, so a save
 * that removes one row and adds another can offer a stored secret to a row it was never saved with. Such a row takes
 * no secret: the operator enters it again.
 */
describe('restoreSecretConfig: a stored list secret goes to no more than one row, and never to a row of other content', () => {
  describe('rows that differ only by their secret', () => {
    const stored = [
      { url: 'a', token: 'sa1' },
      { url: 'b', token: 'sb' },
      { url: 'a', token: 'sa2' },
    ];

    it('gives the kept duplicate no secret of another row when the first duplicate is removed and a row is added', () => {
      expect(save(stored, [mask('b'), mask('a'), added('new')])).toEqual(['b:sb', 'a:-', 'new:-']);
    });

    it('still takes the secret of a duplicate for the kept duplicate when the last one is removed', () => {
      expect(save(stored, [mask('a'), mask('b'), added('new')])).toEqual(['a:sa1', 'b:sb', 'new:-']);
    });

    it('gives a kept unique row no secret of a duplicate when two pairs share their fields', () => {
      const pairs = [
        { url: 'a', token: 's0' },
        { url: 'b', token: 's1' },
        { url: 'a', token: 's2' },
        { url: 'b', token: 's3' },
      ];

      expect(save(pairs, [mask('a'), mask('a'), mask('b'), added('new')])).toEqual(['a:s0', 'a:s2', 'b:-', 'new:-']);
    });

    it('keeps a duplicate renamed in place on its own secret when no row moved', () => {
      const twins = [
        { url: 'a', token: 's0' },
        { url: 'a', token: 's1' },
      ];

      expect(save(twins, [mask('a'), mask('renamed')])).toEqual(['a:s0', 'renamed:s1']);
    });

    it('stores a typed secret as typed in each of these saves', () => {
      expect(save(stored, [mask('b'), { url: 'a', token: 'typed' }, added('new')])).toEqual([
        'b:sb',
        'a:typed',
        'new:-',
      ]);
    });
  });

  describe('a row whose secret was cleared or typed over', () => {
    const stored = [
      { url: 'url0', token: 's0' },
      { url: 'url1', token: 's1' },
      { url: 'url2', token: 's2' },
    ];

    it('does not hand its stored secret to the renamed row at its old position', () => {
      expect(save(stored, [added('url1'), mask('renamed'), added('new')])).toEqual(['url1:-', 'renamed:-', 'new:-']);
    });

    it('does not hand the secret it replaced to the renamed row at its old position', () => {
      expect(save(stored, [{ url: 'url1', token: 'typed' }, mask('renamed'), added('new')])).toEqual([
        'url1:typed',
        'renamed:-',
        'new:-',
      ]);
    });

    it('does not hand the secret of a duplicate that was cleared to the kept duplicate', () => {
      const pairs = [
        { url: 'url0', token: 's0' },
        { url: 'url1', token: 's1' },
        { url: 'url0', token: 's2' },
        { url: 'url1', token: 's3' },
      ];

      expect(save(pairs, [mask('url1'), mask('renamed'), added('new0'), added('new1')])).toEqual([
        'url1:-',
        'renamed:-',
        'new0:-',
        'new1:-',
      ]);
      expect(save(pairs, [added('url1'), mask('url1'), added('new0'), added('new1')])).toEqual([
        'url1:-',
        'url1:-',
        'new0:-',
        'new1:-',
      ]);
    });
  });

  describe('rows that share the content of one stored row', () => {
    it('keeps the stored secret on the row at its position when another row is renamed to its content', () => {
      const stored = [
        { url: 'x', token: 's0' },
        { url: 'a', token: 's1' },
      ];

      expect(save(stored, [mask('a'), mask('a')])).toEqual(['a:-', 'a:s1']);
    });

    it('keeps the stored secret on the first of them when none sits at its position', () => {
      const stored = [
        { url: 'x', token: 's0' },
        { url: 'y', token: 's1' },
        { url: 'a', token: 's2' },
      ];

      expect(save(stored, [mask('a'), mask('a'), added('new')])).toEqual(['a:s2', 'a:-', 'new:-']);
    });
  });
});

type Variant = 'mask' | 'typed' | 'omit' | 'blank';

const rowOf = (url: string, variant: Variant, index: number): Row => {
  if (variant === 'mask') return mask(url);
  if (variant === 'typed') return { url, token: `typed${index}` };
  if (variant === 'blank') return { url, token: '' };
  return { url };
};

/**
 * Every list of up to `maxRows` rows that an API client can send, in any order, whatever the rows are named: the
 * content of a stored row (so rows can be moved onto one another), or a name no stored row has. Each secret is masked,
 * typed over, blank or left out. What the dashboard can send is a small part of it.
 */
function* listsOf(contents: string[], variants: Variant[], maxRows: number): Generator<Array<[string, Variant]>> {
  const types = contents.flatMap(url => variants.map((variant): [string, Variant] => [url, variant]));
  function* walk(rows: Array<[string, Variant]>): Generator<Array<[string, Variant]>> {
    if (rows.length > 0) yield rows;
    if (rows.length === maxRows) return;
    for (const type of types) yield* walk([...rows, type]);
  }
  yield* walk([]);
}

const ALL_VARIANTS: Variant[] = ['mask', 'typed', 'omit', 'blank'];

describe.each<[string, string[], Variant[], number]>([
  ['three rows with other content each', ['a', 'b', 'c'], ALL_VARIANTS, 3],
  ['a pair and a unique row', ['a', 'a', 'b'], ALL_VARIANTS, 3],
  ['a pair around a unique row', ['a', 'b', 'a'], ALL_VARIANTS, 3],
  ['three rows that differ only by their secret', ['a', 'a', 'a'], ALL_VARIANTS, 3],
  ['two pairs', ['a', 'b', 'a', 'b'], ['mask', 'typed', 'omit'], 4],
  // Saves with one row more than are stored: the length changes, which takes another path.
  ['two rows with other content each, saved with a third row', ['a', 'b'], ALL_VARIANTS, 3],
  ['two rows that differ only by their secret, saved with a third row', ['a', 'a'], ALL_VARIANTS, 3],
  ['a pair and a unique row, saved with a fourth row', ['a', 'a', 'b'], ['mask', 'typed', 'omit'], 4],
])('restoreSecretConfig: any save against %s', (_, storedUrls, variants, maxRows) => {
  const stored = storedUrls.map((url, i) => ({ url, token: `secret${i}` }));
  const urlOfSecret = (token: string): string => stored[Number(token.slice('secret'.length))].url;
  const contents = [...new Set(storedUrls), 'renamed'];

  it('puts no stored secret on two rows, on a row of other content or on a typed one, and keeps what a row is owed', () => {
    const found = {
      lists: 0,
      twoRows: [] as string[],
      otherContent: [] as string[],
      typed: [] as string[],
      own: [] as string[],
    };
    for (const list of listsOf(contents, variants, maxRows)) {
      const saved = list.map(([url, variant], index) => rowOf(url, variant, index));
      let tokens: Array<string | undefined>;
      try {
        tokens = rowsOf(stored, saved).map(row => row.token);
      } catch (error) {
        if (error instanceof BadRequestException) continue; // refused with a 400: nothing is written
        throw error;
      }
      found.lists++;
      const render = (): string => `${JSON.stringify(saved)} -> ${JSON.stringify(tokens)}`;

      const storedTokens = tokens.filter((token): token is string => token?.startsWith('secret') === true);
      if (new Set(storedTokens).size !== storedTokens.length) found.twoRows.push(render());

      list.forEach(([url, variant], index) => {
        const token = tokens[index];
        if (variant === 'typed' && token !== `typed${index}`) found.typed.push(render());
        if (!token?.startsWith('secret')) return;
        const keptOnItsRow = stored[index]?.token === token && stored.length === saved.length;
        // A row with the content of a stored row takes the secret of one with that content only. A renamed row, which
        // has none, takes the one at its own position: an in-place edit.
        const fits = storedUrls.includes(url) ? urlOfSecret(token) === url : keptOnItsRow;
        if (!fits) found.otherContent.push(render());
      });

      // A masked row that is the only one with the content of exactly one stored row is owed that row's secret.
      list.forEach(([url, variant], index) => {
        const owners = stored.filter(row => row.url === url);
        const masks = list.filter(([other, otherVariant]) => other === url && otherVariant === 'mask').length;
        if (variant === 'mask' && owners.length === 1 && masks === 1 && tokens[index] !== owners[0].token) {
          found.own.push(render());
        }
      });
    }

    expect(found.lists).toBeGreaterThan(100);
    expect(found.twoRows.slice(0, 3)).toEqual([]);
    expect(found.otherContent.slice(0, 3)).toEqual([]);
    expect(found.typed.slice(0, 3)).toEqual([]);
    expect(found.own.slice(0, 3)).toEqual([]);
  });
});

type Secret = 'mask' | 'typed' | 'omit';
interface SavedRow {
  /** The stored row this row stands for, or null for a row the save adds. */
  origin: number | null;
  renamed: boolean;
  secret: Secret;
}

/**
 * Every list the dashboard can send for `n` stored rows: the kept rows stay in their order, since it has no control to
 * reorder rows, each renamed or not and with its secret masked, typed over or cleared; added rows follow, with no
 * secret or a typed one.
 */
function* dashboardLists(n: number): Generator<SavedRow[]> {
  for (let keep = 0; keep < 1 << n; keep++) {
    const kept = Array.from({ length: n }, (_, i) => i).filter(i => keep & (1 << i));
    for (let variant = 0; variant < 6 ** kept.length; variant++) {
      const rows = kept.map((origin, position): SavedRow => {
        const code = Math.floor(variant / 6 ** position) % 6;
        return { origin, renamed: code >= 3, secret: (['mask', 'typed', 'omit'] as const)[code % 3] };
      });
      for (let adds = 0; adds <= 2; adds++) {
        for (let typed = 0; typed < 1 << adds; typed++) {
          const list = [...rows];
          for (let add = 0; add < adds; add++) {
            list.push({ origin: null, renamed: false, secret: typed & (1 << add) ? 'typed' : 'omit' });
          }
          if (list.length > 0) yield list;
        }
      }
    }
  }
}

/**
 * Whatever a save is, a secret goes onto a row only if some edit of the stored rows, made in the dashboard, leaves that
 * secret on that row: removing rows, renaming them, masking, typing over or clearing a secret, and adding rows. The
 * rows of one payload can come from several such edits, and a payload that cannot say which one it is has to save the
 * rows it cannot place without a secret.
 */
describe.each([
  [2, false, 321],
  [3, false, 2106],
  [3, true, 2085],
])(
  'restoreSecretConfig: every save the dashboard can send for %i stored rows (rows repeat: %s)',
  (n, repeat, payloads) => {
    const stored = Array.from({ length: n }, (_, i) => ({
      url: repeat ? `url${i % 2}` : `url${i}`,
      token: `secret${i}`,
    }));

    it('saves a secret only on a row that some edit leaves it on', () => {
      const edits = new Map<string, { saved: Row[]; expected: Array<Array<string | undefined>> }>();
      for (const rows of dashboardLists(n)) {
        let added = 0;
        const saved = rows.map((row, index): Row => {
          const url =
            row.origin === null
              ? `new${added++}`
              : row.renamed
                ? `renamed${index}`
                : repeat
                  ? `url${row.origin % 2}`
                  : `url${row.origin}`;
          return rowOf(url, row.secret, index);
        });
        const expected = rows.map((row, index) =>
          row.secret === 'typed'
            ? `typed${index}`
            : row.secret === 'mask' && row.origin !== null
              ? `secret${row.origin}`
              : undefined,
        );
        const key = JSON.stringify(saved);
        const edit = edits.get(key) ?? { saved, expected: [] };
        edit.expected.push(expected);
        edits.set(key, edit);
      }

      const unexplained: string[] = [];
      for (const [key, { saved, expected }] of edits) {
        let tokens: Array<string | undefined>;
        try {
          tokens = rowsOf(stored, saved).map(row => row.token);
        } catch (error) {
          if (error instanceof BadRequestException) continue;
          throw error;
        }
        tokens.forEach((token, index) => {
          if (token !== undefined && !expected.some(edit => edit[index] === token)) {
            unexplained.push(`${key} -> row ${index} got ${token}`);
          }
        });
      }

      expect(edits.size).toBe(payloads);
      expect(unexplained.slice(0, 3)).toEqual([]);
    });
  },
);
