import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  BODY_WIDTH_MESSAGES,
  MAX_BODY_ARRAY_LENGTH,
  MAX_BODY_ENTRIES,
  MAX_BODY_OBJECT_KEYS,
  exceededBodyWidth,
} from './body-width';

describe('exceededBodyWidth', () => {
  const array = (length: number): number[] => Array.from({ length }, () => 1);
  const object = (length: number): Record<string, number> =>
    Object.fromEntries(Array.from({ length }, (_, index) => [`k${index}`, 1]));
  /** Arrays of at most 9,999 numbers under one root array: exactly `entries` array elements and keys in all. */
  const bodyOfEntries = (entries: number): number[][] => {
    const arrays = Math.ceil(entries / 10_000);
    return Array.from({ length: arrays }, (_, index) =>
      array(index < arrays - 1 ? 9_999 : entries - arrays - (arrays - 1) * 9_999),
    );
  };

  it('accepts scalars, empty containers and a container exactly at its bound', () => {
    for (const value of [
      null,
      undefined,
      'text',
      7,
      true,
      [],
      {},
      array(MAX_BODY_ARRAY_LENGTH),
      object(MAX_BODY_OBJECT_KEYS),
    ]) {
      expect(exceededBodyWidth(value)).toBeUndefined();
    }
  });

  it('accepts a body of exactly the total, however it is split', () => {
    expect(exceededBodyWidth(bodyOfEntries(MAX_BODY_ENTRIES))).toBeUndefined();
  });

  it('names the array limit for an array one element past it', () => {
    expect(exceededBodyWidth(array(MAX_BODY_ARRAY_LENGTH + 1))).toBe('array');
  });

  it('names the object limit for an object one key past it', () => {
    expect(exceededBodyWidth(object(MAX_BODY_OBJECT_KEYS + 1))).toBe('object');
  });

  it('names the total limit for a body of many small containers that adds up to one entry past it', () => {
    expect(exceededBodyWidth(bodyOfEntries(MAX_BODY_ENTRIES + 1))).toBe('total');
    expect(exceededBodyWidth({ a: [object(100)], b: bodyOfEntries(MAX_BODY_ENTRIES) })).toBe('total');
  });

  it('finds a wide container at any depth, in an array or an object', () => {
    expect(exceededBodyWidth({ a: [{ b: { c: [array(MAX_BODY_ARRAY_LENGTH + 1)] } }] })).toBe('array');
    expect(exceededBodyWidth([[{ deep: object(MAX_BODY_OBJECT_KEYS + 1) }]])).toBe('object');
  });

  it('refuses an oversized array from its length, without visiting an element', () => {
    let reads = 0;
    const padded = new Proxy(array(MAX_BODY_ARRAY_LENGTH + 1), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(exceededBodyWidth(padded)).toBe('array');
    expect(reads).toBe(0);
  });

  it('names each limit in its message', () => {
    expect(BODY_WIDTH_MESSAGES.array).toContain(String(MAX_BODY_ARRAY_LENGTH));
    expect(BODY_WIDTH_MESSAGES.object).toContain(String(MAX_BODY_OBJECT_KEYS));
    expect(BODY_WIDTH_MESSAGES.total).toContain(String(MAX_BODY_ENTRIES));
  });
});

/**
 * The array bound is a constant, chosen once: the largest ArrayMaxSize any request DTO declares, rounded up to the
 * next power of ten, and never below 10,000. This reads the declarations out of class-validator's own registry (the
 * walk dto-strict-coercion.spec.ts makes, including classes that are never exported), so a DTO that starts to allow
 * a longer list fails here instead of being refused by a bound nobody revisited.
 */
describe('the width bounds against the request DTOs', () => {
  function dtoFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) dtoFiles(path, out);
      else if (path.endsWith('.dto.ts')) out.push(path);
    }
    return out;
  }

  // Importing every DTO module registers its decorators, which happens when the module is loaded.
  dtoFiles(join(__dirname, '..', '..')).forEach(file => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(file);
  });

  const declaredArrayMaxima = (): number[] => {
    const registry = (
      getMetadataStorage() as unknown as {
        validationMetadatas?: Map<unknown, Array<{ name?: string; constraints?: unknown[] }>>;
      }
    ).validationMetadatas;
    if (!(registry instanceof Map)) {
      // The internal shape changed. Fail loudly: a silently empty scan would report no drift.
      throw new Error('class-validator metadata registry is not the expected Map; update this spec');
    }
    return [...registry.values()]
      .flat()
      .filter(meta => meta.name === 'arrayMaxSize')
      .map(meta => Number(meta.constraints?.[0]));
  };

  it('finds the declared maxima, so the check below cannot pass on an empty scan', () => {
    const maxima = declaredArrayMaxima();

    expect(maxima.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...maxima)).toBeGreaterThanOrEqual(2000);
  });

  it('keeps the array bound at the largest declared ArrayMaxSize rounded up to the next power of ten, at least 10,000', () => {
    const largest = Math.max(...declaredArrayMaxima());

    expect(MAX_BODY_ARRAY_LENGTH).toBe(Math.max(10_000, 10 ** Math.ceil(Math.log10(largest))));
  });
});
