import { readFileSync } from 'fs';
import { join } from 'path';
import { sweepOrphanedFiles } from './orphan-sweep';

const HOUR = 3_600_000;

/** Files one prefix can hold unreferenced before a sweep needs more than two passes to clear them. */
const TWO_PASS_LIMIT = 100_000;

/** Files each hourly pass (one hour grace, the defaults) deletes from `total` unreferenced files, until none is left. */
async function removedPerPass(total: number): Promise<number[]> {
  const left = new Set(Array.from({ length: total }, (_, i) => `statuses/s1/${i}.bin`));
  const storage = {
    iterateFiles: async function* (): AsyncGenerator<string> {
      await Promise.resolve();
      for (const key of [...left]) yield key;
    },
    deleteFile: (key: string): Promise<void> => {
      left.delete(key);
      return Promise.resolve();
    },
  };
  const firstSeenAt = new Map<string, number>();
  const perPass: number[] = [];
  while (left.size > 0 && perPass.length < 10) {
    perPass.push(
      await sweepOrphanedFiles({
        storage,
        prefix: 'statuses/',
        graceMs: HOUR,
        now: perPass.length * HOUR,
        firstSeenAt,
        chunkSize: 500,
        referencedAmong: () => Promise.resolve(new Set<string | undefined>()),
        onDeleteFailed: jest.fn(),
      }),
    );
  }
  return perPass;
}

describe('the passes an hourly orphan sweep needs for the unreferenced files of one prefix', () => {
  it.each([
    [TWO_PASS_LIMIT, [0, TWO_PASS_LIMIT]],
    [TWO_PASS_LIMIT + 1, [0, TWO_PASS_LIMIT, 1]],
    [TWO_PASS_LIMIT + 50_000, [0, TWO_PASS_LIMIT, 50_000]],
  ])('takes %i files out in the passes %j', async (total, expected) => {
    expect(await removedPerPass(total)).toEqual(expected);
  });

  it('is the count the API reference gives for what a session delete leaves in the media store', () => {
    const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', '06-api-specification.md'), 'utf8');
    const paragraph = doc.split('\n').find(line => line.startsWith('The delete removes no file from the media store.'));
    expect(paragraph).toBeDefined();
    expect(new Set(paragraph?.match(/\b\d{5,}\b/g))).toEqual(new Set([String(TWO_PASS_LIMIT)]));
  });
});
