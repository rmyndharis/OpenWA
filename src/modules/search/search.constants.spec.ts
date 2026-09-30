describe('SEARCH_LIMIT_MAX', () => {
  const orig = process.env.SEARCH_LIMIT_MAX;
  afterEach(() => {
    if (orig === undefined) delete process.env.SEARCH_LIMIT_MAX;
    else process.env.SEARCH_LIMIT_MAX = orig;
  });

  const load = (raw: string | undefined): number => {
    if (raw === undefined) delete process.env.SEARCH_LIMIT_MAX;
    else process.env.SEARCH_LIMIT_MAX = raw;
    let value = 0;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      value = (require('./search.constants') as typeof import('./search.constants')).SEARCH_LIMIT_MAX;
    });
    return value;
  };

  it('honors a positive integer', () => {
    expect(load('250')).toBe(250);
  });

  it.each([undefined, '', '0', '-5', '2.5', 'abc', '5x'])('falls back to 100 for %p', raw => {
    expect(load(raw)).toBe(100);
  });
});
