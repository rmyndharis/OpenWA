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

const stored = {
  endpoints: [
    { url: 'a', token: 'secret-a' },
    { url: 'b', token: 'secret-b' },
    { url: 'c', token: 'secret-c' },
  ],
};

const masked = (url: string): Record<string, unknown> => ({ url, token: SECRET_SENTINEL });
// What the dashboard seeds for a row added in the form: a blank secret.
const added = (url: string): Record<string, unknown> => ({ url, token: '' });

const save = (endpoints: Array<Record<string, unknown>>): Array<string | undefined> =>
  (restoreSecretConfig({ endpoints }, stored, schema).endpoints as Array<{ token?: string }>).map(row => row.token);

/**
 * A stored secret belongs to the one row it was saved with. The dashboard sends every kept row with the mask and a
 * row added in the form with a blank secret, so the rows of a save that adds or removes some are told apart by their
 * content. A row with no stored counterpart of its own is saved without a secret, never with another row's.
 */
describe('restoreSecretConfig: a stored row secret binds to one row of the saved list', () => {
  it('gives a row added in the same save as another is removed no secret of a kept row', () => {
    expect(save([masked('a'), masked('c'), added('new')])).toEqual(['secret-a', 'secret-c', undefined]);
  });

  it('gives a row added after the first row is removed no secret of a kept row', () => {
    expect(save([masked('b'), masked('c'), added('new')])).toEqual(['secret-b', 'secret-c', undefined]);
  });

  it('gives a renamed row no secret of a kept row when the same save also moves rows', () => {
    expect(save([masked('c'), masked('b'), masked('a-renamed')])).toEqual(['secret-c', 'secret-b', undefined]);
  });

  it('does not hand a removed row secret to a renamed row of the same save', () => {
    // a is removed, b is renamed in place, one row is added: no row is left at a's position to carry its secret.
    expect(save([masked('b-renamed'), masked('c'), added('new')])).toEqual([undefined, 'secret-c', undefined]);
  });

  it('gives an added row no secret of a row renamed in the same save that also removes another', () => {
    expect(save([masked('b'), masked('c-renamed'), added('new')])).toEqual(['secret-b', undefined, undefined]);
  });

  it('keeps no secret for a row whose secret was cleared, nor gives it to the added row', () => {
    const cleared = { url: 'b' };
    expect(save([cleared, masked('c'), added('new')])).toEqual([undefined, 'secret-c', undefined]);
  });

  it('stores a typed secret as typed and gives no other row a secret by position', () => {
    expect(save([{ url: 'b', token: 'typed' }, masked('c'), added('new')])).toEqual(['typed', 'secret-c', undefined]);
  });

  // The payload of a row renamed in place next to a removed row and an added one also fits a removed row whose
  // neighbour was renamed into its place: the rule saves neither with a secret, so one secret is entered again.
  it('drops the secret of a row renamed in place when the same save also removes a row before a kept one', () => {
    expect(save([masked('a-renamed'), masked('c'), added('new')])).toEqual([undefined, 'secret-c', undefined]);
  });

  describe('what stays as it was', () => {
    it('keeps the secret of a row renamed in place when every kept row stays where it was', () => {
      expect(save([masked('a'), masked('b-renamed'), masked('c')])).toEqual(['secret-a', 'secret-b', 'secret-c']);
    });

    it('saves a row renamed in place without its secret when the same save adds a row, as it always did', () => {
      expect(save([masked('a-renamed'), masked('b'), masked('c'), added('new')])).toEqual([
        undefined,
        'secret-b',
        'secret-c',
        undefined,
      ]);
    });

    it('keeps the secret of the last row when one replaces it in place, which a rename cannot be told from', () => {
      expect(save([masked('a'), masked('b'), added('replacement')])).toEqual(['secret-a', 'secret-b', 'secret-c']);
    });

    it('restores each secret on a save that changes nothing, reorders, or removes by content', () => {
      expect(save([masked('a'), masked('b'), masked('c')])).toEqual(['secret-a', 'secret-b', 'secret-c']);
      expect(save([masked('c'), masked('a'), masked('b')])).toEqual(['secret-c', 'secret-a', 'secret-b']);
      expect(save([masked('a'), masked('c')])).toEqual(['secret-a', 'secret-c']);
    });
  });
});

type Secret = 'mask' | 'typed' | 'omit' | 'blank';
interface SavedRow {
  /** The stored row this row stands for, or null for a row the save adds. */
  origin: number | null;
  renamed: boolean;
  secret: Secret;
}

/** Every list of up to n + 1 rows made of the stored rows (kept or renamed, once each, in any order) and added ones. */
function* savedLists(n: number): Generator<SavedRow[]> {
  const rows: SavedRow[] = [];
  const used = new Set<number>();
  let added = 0;
  function* walk(): Generator<SavedRow[]> {
    yield [...rows];
    if (rows.length === n + 1) return;
    for (let origin = 0; origin < n; origin++) {
      if (used.has(origin)) continue;
      used.add(origin);
      for (const renamed of [false, true]) {
        for (const secret of ['mask', 'typed', 'omit'] as const) {
          rows.push({ origin, renamed, secret });
          yield* walk();
          rows.pop();
        }
      }
      used.delete(origin);
    }
    if (added < 2) {
      added++;
      for (const secret of ['blank', 'typed', 'omit'] as const) {
        rows.push({ origin: null, renamed: false, secret });
        yield* walk();
        rows.pop();
      }
      added--;
    }
  }
  yield* walk();
}

const savedOf = (rows: SavedRow[]): Record<string, unknown> => {
  let addedSoFar = 0;
  return {
    endpoints: rows.map((row, index) => {
      const url = row.origin === null ? `new${addedSoFar++}` : `url${row.origin}${row.renamed ? '-renamed' : ''}`;
      const saved: Record<string, unknown> = { url };
      if (row.secret === 'mask') saved.token = SECRET_SENTINEL;
      else if (row.secret === 'blank') saved.token = '';
      else if (row.secret === 'typed') saved.token = `typed${index}`;
      return saved;
    }),
  };
};

// A row stands for its stored row by content when its non-secret fields are unchanged and its secret is still there,
// masked or typed over.
const matchesByContent = (row: SavedRow): boolean => row.origin !== null && !row.renamed && row.secret !== 'omit';

describe.each([1, 2, 3])('restoreSecretConfig: every save of up to four rows against %i stored rows', n => {
  const stored = {
    endpoints: Array.from({ length: n }, (_, i) => ({ url: `url${i}`, token: `secret${i}` })),
  };
  const found = { lists: 0, moved: 0, twoRows: [] as string[], ownSecret: [] as string[], byPosition: [] as string[] };

  beforeAll(() => {
    for (const rows of savedLists(n)) {
      if (rows.length === 0) continue;
      found.lists++;
      const tokens = (restoreSecretConfig(savedOf(rows), stored, schema).endpoints as Array<{ token?: string }>).map(
        row => row.token,
      );
      const render = (): string => `${JSON.stringify(savedOf(rows).endpoints)} -> ${JSON.stringify(tokens)}`;

      const storedSecrets = tokens.filter(token => token?.startsWith('secret'));
      if (new Set(storedSecrets).size !== storedSecrets.length) found.twoRows.push(render());

      const keepsOwn = rows.every((row, index) => {
        if (row.secret === 'typed') return tokens[index] === `typed${index}`;
        return !(row.secret === 'mask' && matchesByContent(row)) || tokens[index] === `secret${row.origin}`;
      });
      if (!keepsOwn) found.ownSecret.push(render());

      if (rows.some((row, index) => matchesByContent(row) && row.origin !== index)) {
        found.moved++;
        const byPosition = rows.some(
          (row, index) => !matchesByContent(row) && row.secret !== 'typed' && tokens[index] !== undefined,
        );
        if (byPosition) found.byPosition.push(render());
      }
    }
  });

  const listCounts = new Map([
    [1, 54],
    [2, 1140],
    [3, 31296],
  ]);

  it('puts no stored secret on two rows', () => {
    expect(found.twoRows.slice(0, 3)).toEqual([]);
    expect(found.lists).toBe(listCounts.get(n));
  });

  it('keeps the secret of a masked row that is unchanged, and a typed one as typed', () => {
    expect(found.ownSecret.slice(0, 3)).toEqual([]);
  });

  it('gives no other row a stored secret once a row that is unchanged has moved', () => {
    expect(found.byPosition.slice(0, 3)).toEqual([]);
    if (n > 1) expect(found.moved).toBeGreaterThan(0);
  });
});
