import { ListingMemo, LISTING_MEMO_TTL_MS } from './listing-memo';

describe('ListingMemo', () => {
  const list = (...ids: string[]) => jest.fn().mockImplementation(() => Promise.resolve(ids.map(id => ({ id }))));

  afterEach(() => jest.restoreAllMocks());

  it('reads afresh for a first page and reuses the list for the later pages', async () => {
    const memo = new ListingMemo<{ id: string }>();
    const load = list('a', 'b');
    await memo.read('s1', 0, load);
    await memo.read('s1', undefined, load);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(memo.read('s1', 1000, load)).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
    await memo.read('s1', 2000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([Number.NaN, -1])('treats offset %s as a first page', async offset => {
    const memo = new ListingMemo<{ id: string }>();
    const load = list('a');
    await memo.read('s1', 0, load);
    await memo.read('s1', offset, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps one list per session', async () => {
    const memo = new ListingMemo<{ id: string }>();
    await memo.read('s1', 0, list('a'));
    const other = list('b');
    await expect(memo.read('s2', 1000, other)).resolves.toEqual([{ id: 'b' }]);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('reads afresh once the list is older than its time to live', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const memo = new ListingMemo<{ id: string }>();
    const load = list('a');
    await memo.read('s1', 0, load);
    clock.mockReturnValue(now + LISTING_MEMO_TTL_MS - 1);
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + LISTING_MEMO_TTL_MS);
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares a read in flight with a later page', async () => {
    const memo = new ListingMemo<{ id: string }>();
    let finish: (items: { id: string }[]) => void = () => undefined;
    const load = jest.fn(() => new Promise<{ id: string }[]>(resolve => (finish = resolve)));
    const first = memo.read('s1', 0, load);
    const later = memo.read('s1', 1000, load);
    finish([{ id: 'a' }]);
    await expect(Promise.all([first, later])).resolves.toEqual([[{ id: 'a' }], [{ id: 'a' }]]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed read, and an older failure leaves a newer list in place', async () => {
    const memo = new ListingMemo<{ id: string }>();
    await expect(memo.read('s1', 0, () => Promise.reject(new Error('page died')))).rejects.toThrow('page died');
    const load = list('a');
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);

    let fail: (error: Error) => void = () => undefined;
    const slow = memo.read('s1', 0, () => new Promise((_, reject) => (fail = reject)));
    await memo.read('s1', 0, load);
    fail(new Error('page died'));
    await expect(slow).rejects.toThrow('page died');
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reads afresh after a drop, including a drop while the read was in flight', async () => {
    const memo = new ListingMemo<{ id: string }>();
    const load = list('a');
    await memo.read('s1', 0, load);
    memo.drop('s1');
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);

    const pending = memo.read('s1', 0, load);
    memo.drop('s1');
    await pending;
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  describe('eviction of an idle list', () => {
    const entryCount = (memo: ListingMemo<{ id: string }>) => memo['entries'].size;

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('releases an expired list although no session reads it again', async () => {
      const memo = new ListingMemo<{ id: string }>();
      const load = list('a');
      await memo.read('s1', 0, load);
      await memo.read('s2', 0, load);
      jest.advanceTimersByTime(LISTING_MEMO_TTL_MS - 1);
      expect(entryCount(memo)).toBe(2);
      jest.advanceTimersByTime(1);
      expect(entryCount(memo)).toBe(0);
      await memo.read('s1', 1000, load);
      expect(load).toHaveBeenCalledTimes(3);
    });

    it('starts the clock when the read ends, not when it starts', async () => {
      const memo = new ListingMemo<{ id: string }>();
      let finish: (items: { id: string }[]) => void = () => undefined;
      const pending = memo.read('s1', 0, () => new Promise(resolve => (finish = resolve)));
      jest.advanceTimersByTime(LISTING_MEMO_TTL_MS * 3);
      expect(entryCount(memo)).toBe(1);
      finish([{ id: 'a' }]);
      await pending;
      jest.advanceTimersByTime(LISTING_MEMO_TTL_MS - 1);
      expect(entryCount(memo)).toBe(1);
      jest.advanceTimersByTime(1);
      expect(entryCount(memo)).toBe(0);
    });

    it('clears the timer when the entry is dropped', async () => {
      const memo = new ListingMemo<{ id: string }>();
      await memo.read('s1', 0, list('a'));
      expect(jest.getTimerCount()).toBe(1);
      memo.drop('s1');
      expect(jest.getTimerCount()).toBe(0);
      expect(entryCount(memo)).toBe(0);
    });

    it('leaves no timer behind for a drop in flight or a failed read', async () => {
      const memo = new ListingMemo<{ id: string }>();
      let finish: (items: { id: string }[]) => void = () => undefined;
      const pending = memo.read('s1', 0, () => new Promise(resolve => (finish = resolve)));
      memo.drop('s1');
      finish([{ id: 'a' }]);
      await pending;
      await expect(memo.read('s2', 0, () => Promise.reject(new Error('page died')))).rejects.toThrow('page died');
      expect(jest.getTimerCount()).toBe(0);
      expect(entryCount(memo)).toBe(0);
    });

    it('does not let the timer of a replaced list evict the list that replaced it', async () => {
      const memo = new ListingMemo<{ id: string }>();
      const load = list('a');
      await memo.read('s1', 0, load);
      jest.advanceTimersByTime(LISTING_MEMO_TTL_MS - 1000);
      await memo.read('s1', 0, load);
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(1000);
      expect(entryCount(memo)).toBe(1);
      await memo.read('s1', 1000, load);
      expect(load).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(LISTING_MEMO_TTL_MS - 1000);
      expect(entryCount(memo)).toBe(0);
    });
  });

  it('does not let the eviction timer keep the process alive', async () => {
    const set = jest.spyOn(global, 'setTimeout');
    await new ListingMemo<{ id: string }>(12_345).read('s1', 0, list('a'));
    const timers = set.mock.calls.flatMap(([, delay], i) =>
      delay === 12_345 ? [set.mock.results[i].value as NodeJS.Timeout] : [],
    );
    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);
    clearTimeout(timers[0]);
  });

  it('hands every caller its own copy of the list', async () => {
    const memo = new ListingMemo<{ id: string }>();
    const first = await memo.read('s1', 0, list('a', 'b'));
    first.reverse().pop();
    await expect(memo.read('s1', 1000, list())).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});
