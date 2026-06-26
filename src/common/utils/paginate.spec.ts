import { paginate } from './paginate';

describe('paginate', () => {
  const items = Array.from({ length: 1500 }, (_, i) => i);

  it('caps an unbounded request at the default limit (1000)', () => {
    const out = paginate(items);
    expect(out.length).toBe(1000);
    expect(out[0]).toBe(0);
    expect(out[999]).toBe(999);
  });

  it('returns exactly `limit` items, clamped to the max (1000)', () => {
    expect(paginate(items, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(paginate(items, 99999).length).toBe(1000); // explicit huge limit clamped to the cap
    expect(paginate(items, 0).length).toBe(1); // clamped up to the minimum of 1
  });

  it('pages with offset', () => {
    expect(paginate(items, 5, 10)).toEqual([10, 11, 12, 13, 14]);
  });

  it('treats a non-finite limit/offset as the safe default (NaN limit -> cap, NaN offset -> 0)', () => {
    expect(paginate(items, NaN).length).toBe(1000);
    expect(paginate(items, 5, NaN)).toEqual([0, 1, 2, 3, 4]);
  });

  it('returns the whole collection when it is under the cap', () => {
    expect(paginate([1, 2, 3])).toEqual([1, 2, 3]);
  });
});
