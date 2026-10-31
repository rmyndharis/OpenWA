import { getHeapStatistics, GCProfiler, setFlagsFromString } from 'v8';
import { runInNewContext } from 'vm';
import { exceedsBodyNesting, exceedsJsonNesting, isUtf8Charset, MAX_BODY_NESTING } from './body-nesting';

// One value holding `levels` nested containers: {} is one level, {a:{}} is two.
const objects = (levels: number): unknown => {
  let value: unknown = {};
  for (let i = 1; i < levels; i++) value = { a: value };
  return value;
};
const arrays = (levels: number): unknown => {
  let value: unknown = [];
  for (let i = 1; i < levels; i++) value = [value];
  return value;
};
// The same documents as JSON text: '{"a":{}}' and '[[]]' are two levels.
const objectText = (levels: number): string => '{"a":'.repeat(levels - 1) + '{}' + '}'.repeat(levels - 1);
const arrayText = (levels: number): string => '['.repeat(levels) + ']'.repeat(levels);
const mixedText = (levels: number): string => {
  let text = '0';
  for (let i = 0; i < levels; i++) text = i % 2 === 0 ? `[${text}]` : `{"a":${text}}`;
  return text;
};
const scan = (text: string): boolean => exceedsJsonNesting(Buffer.from(text));

// The documented limit is written as a literal on purpose, the way field-limits.dto.spec.ts pins the other
// documented limits: the 400 text and the release notes say 100, so moving the cap has to fail a test here.
describe('the documented nesting limit', () => {
  it('is 100 levels', () => {
    expect(MAX_BODY_NESTING).toBe(100);
  });

  it.each([
    ['objects', objectText],
    ['arrays', arrayText],
    ['alternating objects and arrays', mixedText],
  ])('admits 100 levels of %s and refuses 101', (_kind, build) => {
    expect(scan(build(100))).toBe(false);
    expect(scan(build(101))).toBe(true);
  });

  it.each([
    ['objects', objects],
    ['arrays', arrays],
  ])('admits a parsed value of 100 levels of %s and refuses 101', (_kind, build) => {
    expect(exceedsBodyNesting(build(100))).toBe(false);
    expect(exceedsBodyNesting(build(101))).toBe(true);
  });
});

describe('exceedsBodyNesting', () => {
  it('measures the deepest branch, not the breadth or the number of nodes', () => {
    const wide = { items: Array.from({ length: 5000 }, () => ({ tags: ['a', 'b'], meta: { k: [1] } })) };
    expect(exceedsBodyNesting(wide)).toBe(false);
    const oneDeepBranch = { items: [...wide.items, { deep: objects(MAX_BODY_NESTING) }] };
    expect(exceedsBodyNesting(oneDeepBranch)).toBe(true);
  });

  // The recursive readers of a body overflow the stack near 2000 levels. The walk stops descending at the
  // cap, so it must answer for a value far deeper than that instead of overflowing like them.
  it.each([
    ['objects', objects],
    ['arrays', arrays],
  ])('answers for %s nested 100000 levels without overflowing the stack', (_kind, build) => {
    expect(exceedsBodyNesting(build(100_000))).toBe(true);
  });

  it.each([[undefined], [null], ['text'], [5], [true], [{}], [[]]])('passes the flat value %j', value => {
    expect(exceedsBodyNesting(value)).toBe(false);
  });
});

describe('exceedsJsonNesting', () => {
  it('counts the deepest branch, not the breadth', () => {
    const wide = `{"items":[${Array.from({ length: 5000 }, () => '{"tags":["a","b"],"meta":{"k":[1]}}').join(',')}]}`;
    expect(scan(wide)).toBe(false);
    // The wrapper adds two levels around the deeper branch: 99 + 2 is 101, 98 + 2 is 100.
    expect(scan(`{"items":[${objectText(97)},${objectText(99)}]}`)).toBe(true);
    expect(scan(`{"items":[${objectText(97)},${objectText(98)}]}`)).toBe(false);
  });

  it('does not count brackets and braces inside strings', () => {
    expect(scan(JSON.stringify({ text: '['.repeat(5000) + '{'.repeat(5000) }))).toBe(false);
    expect(scan(JSON.stringify({ ['['.repeat(500)]: 1 }))).toBe(false);
  });

  it('reads an escaped quote as part of the string, so what follows it is still inside', () => {
    expect(scan('{"a":"say \\"' + '['.repeat(500) + '\\" now"}')).toBe(false);
  });

  it('reads an escaped backslash as complete, so a quote after it ends the string', () => {
    // "\\" is one backslash; the quote closes the string and the brackets that follow are structure.
    expect(scan('["\\\\",' + '['.repeat(101) + ']'.repeat(101) + ']')).toBe(true);
    expect(scan('["\\\\",' + '['.repeat(98) + ']'.repeat(98) + ']')).toBe(false);
  });

  it('is not fooled by non-ASCII text around the structure', () => {
    const text = JSON.stringify({ 'ключ[': ['日本語[[[', '\u{1F600}"', 'é\\'], nested: objects(98) });
    expect(scan(text)).toBe(false);
    expect(scan(`["日本語",${arrayText(100)}]`)).toBe(true);
  });

  it('decides on the first level past the cap, before reading the rest of the body', () => {
    // Never closed and not valid JSON: the answer must not depend on reading it to the end.
    expect(scan('['.repeat(101))).toBe(true);
    expect(scan('['.repeat(100))).toBe(false);
  });

  it('answers for a body nested 100000 levels, and for an array of 8 million empty arrays', () => {
    expect(scan(arrayText(100_000))).toBe(true);
    expect(exceedsJsonNesting(Buffer.from('[' + '[],'.repeat(8_000_000) + '[]]'))).toBe(false);
  });

  // The scan has to agree with the walk over the parsed value, for any text. Random documents built around the
  // cap, with keys and strings made of the characters that matter to the scan.
  it('agrees with the walk over the parsed value on random documents around the cap', () => {
    let seed = 20261022;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pieces = [
      '',
      'a',
      '[',
      ']',
      '{',
      '}',
      '"',
      '\\',
      '\\"',
      '[[[[',
      '"}]',
      'é',
      '日本',
      '\u{1F600}',
      '\u0000',
      ':,',
    ];
    const text = (): string => pieces[Math.floor(next() * pieces.length)] + pieces[Math.floor(next() * pieces.length)];
    const leaf = (): unknown => [text(), 1, true, null, text()][Math.floor(next() * 5)];
    for (let levels = 95; levels <= 105; levels++) {
      for (let n = 0; n < 40; n++) {
        let value: unknown = leaf();
        for (let i = 0; i < levels; i++) {
          value = next() < 0.5 ? [leaf(), value, leaf()] : { [text()]: leaf(), [`k${text()}`]: value };
        }
        const json = JSON.stringify(value);
        expect(scan(json)).toBe(levels > MAX_BODY_NESTING);
        expect(exceedsBodyNesting(JSON.parse(json))).toBe(levels > MAX_BODY_NESTING);
      }
    }
  });

  // The scan runs on every JSON body before authentication. What made the walk over the parsed value expensive
  // was an allocation for every container, so what keeps the scan cheap is that it allocates nothing at all, not
  // even something it drops at once. That is measured as allocation volume and not on a clock: a time ratio
  // against JSON.parse fails intermittently under the coverage instrumentation the test job runs with, which
  // slows the byte loop and leaves the native parse alone. And not as the heap left after the scan, which counts
  // only what survived: a scan that allocates an array per container and discards it leaves almost nothing
  // behind. The volume is what the heap grew by plus what the collector reclaimed during the scan, which sum to
  // the bytes allocated whenever the collector ran; a full collection first leaves the heap empty of earlier
  // garbage, so no collection in the window reclaims anything the scan did not allocate.
  const allocatedWhileScanning = (body: Buffer): { exceeds: boolean; allocated: number } => {
    setFlagsFromString('--expose-gc');
    const collect = runInNewContext('gc') as () => void;
    collect();

    const profiler = new GCProfiler();
    const before = getHeapStatistics().used_heap_size;
    profiler.start();
    const exceeds = exceedsJsonNesting(body);
    const after = getHeapStatistics().used_heap_size;
    const { statistics } = profiler.stop();

    const reclaimed = statistics.reduce(
      (sum, run) => sum + run.beforeGC.heapStatistics.usedHeapSize - run.afterGC.heapStatistics.usedHeapSize,
      0,
    );
    return { exceeds, allocated: after - before + reclaimed };
  };

  // One shape per way a scan could start allocating: for each container, for each key or string, and for each
  // container that holds strings. A body of 12 MB holds over a million of them, so any allocation per item is
  // tens of megabytes; the scan itself allocates nothing, and the margin is a small fraction of that.
  it.each([
    ['many keys', (bytes: number) => `{${Array.from({ length: bytes / 10 }, (_, i) => `"k${i}":0`).join(',')}}`],
    ['many small containers', (bytes: number) => `[${'[0],'.repeat(bytes / 4 - 1)}[0]]`],
    ['many empty arrays', (bytes: number) => `[${'[],'.repeat(bytes / 3 - 1)}[]]`],
    ['many small objects', (bytes: number) => `[${'{"a":"b"},'.repeat(bytes / 10 - 1)}{"a":"b"}]`],
  ])('allocates nothing, not even briefly, for a body of %s', (_shape, make) => {
    const { exceeds, allocated } = allocatedWhileScanning(Buffer.from(make(12_000_000)));

    expect(exceeds).toBe(false);
    expect(allocated).toBeLessThan(1024 * 1024);
  });
});

describe('isUtf8Charset', () => {
  // The labels iconv-lite, which decodes the body, reads as UTF-8: lower-cased, with every character that is
  // not a letter or digit dropped, and a trailing ':NNNN' year.
  it.each(['utf-8', 'UTF-8', 'Utf-8', 'utf8', 'utf-8.', 'utf-_8', 'utf--8', 'utf-8:1993', 'utf-8!'])(
    'reads %j as UTF-8',
    charset => {
      expect(isUtf8Charset(charset)).toBe(true);
    },
  );

  it.each(['utf-16', 'utf-16le', 'utf-16be', 'utf-32', 'utf-7', 'utf-80', 'utf-8:19930', 'iso-8859-1', 'ascii', ''])(
    'does not read %j as UTF-8',
    charset => {
      expect(isUtf8Charset(charset)).toBe(false);
    },
  );
});
