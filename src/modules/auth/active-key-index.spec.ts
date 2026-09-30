import { createHash, createHmac } from 'crypto';
import { Repository } from 'typeorm';
import { ActiveKeyIndex } from './active-key-index';
import { ApiKey } from './entities/api-key.entity';

const sha = (key: string) => createHash('sha256').update(key).digest('hex');

type Row = Pick<ApiKey, 'keyHash' | 'allowedIps' | 'expiresAt'>;

const indexOver = (rows: Row[] | (() => Promise<Row[]>)) => {
  const find = jest.fn(typeof rows === 'function' ? rows : () => Promise.resolve(rows));
  const index = new ActiveKeyIndex({ find } as unknown as Repository<ApiKey>);
  return { index, find };
};

const row = (key: string, extra: Partial<Row> = {}): Row => ({
  keyHash: sha(key),
  allowedIps: null,
  expiresAt: null,
  ...extra,
});

describe('ActiveKeyIndex', () => {
  const pepper = process.env.API_KEY_PEPPER;
  afterEach(() => {
    if (pepper === undefined) delete process.env.API_KEY_PEPPER;
    else process.env.API_KEY_PEPPER = pepper;
    jest.useRealTimers();
  });

  it('recognises an active key from X-API-Key or a Bearer token, trimmed', async () => {
    const { index, find } = indexOver([row('k1')]);
    await index.onApplicationBootstrap();
    index.onModuleDestroy();

    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true } }));
    expect(index.recognise({ 'x-api-key': ' k1 ' }, '192.0.2.1')).toBe(sha('k1'));
    expect(index.recognise({ authorization: 'Bearer k1' }, '192.0.2.1')).toBe(sha('k1'));
    expect(index.recognise({ 'x-api-key': 'nope' }, '192.0.2.1')).toBeUndefined();
    expect(index.recognise({}, '192.0.2.1')).toBeUndefined();
  });

  it('reads X-API-Key before the Bearer token, as the guard does', async () => {
    const { index } = indexOver([row('k1')]);
    await index.onApplicationBootstrap();
    index.onModuleDestroy();
    expect(index.recognise({ 'x-api-key': 'nope', authorization: 'Bearer k1' }, '192.0.2.1')).toBeUndefined();
  });

  it('hashes with the pepper when one is set', async () => {
    process.env.API_KEY_PEPPER = 'pepper';
    const peppered = createHmac('sha256', 'pepper').update('k1').digest('hex');
    const { index } = indexOver([{ keyHash: peppered, allowedIps: null, expiresAt: null }]);
    await index.onApplicationBootstrap();
    index.onModuleDestroy();
    expect(index.recognise({ 'x-api-key': 'k1' }, '192.0.2.1')).toBe(peppered);
  });

  it('ignores an expired key and one used from outside its allowed addresses', async () => {
    const { index } = indexOver([
      row('old', { expiresAt: new Date(Date.now() - 1000) }),
      row('fenced', { allowedIps: ['10.0.0.0/8'] }),
    ]);
    await index.onApplicationBootstrap();
    index.onModuleDestroy();
    expect(index.recognise({ 'x-api-key': 'old' }, '192.0.2.1')).toBeUndefined();
    expect(index.recognise({ 'x-api-key': 'fenced' }, '192.0.2.1')).toBeUndefined();
    expect(index.recognise({ 'x-api-key': 'fenced' }, '10.1.2.3')).toBe(sha('fenced'));
  });

  it('keeps the previous view when a refresh fails', async () => {
    let fail = false;
    const { index } = indexOver(() => (fail ? Promise.reject(new Error('db down')) : Promise.resolve([row('k1')])));
    await index.onApplicationBootstrap();
    fail = true;
    index.refreshSoon();
    await (index as unknown as { loading: Promise<void> }).loading;
    index.onModuleDestroy();
    expect(index.recognise({ 'x-api-key': 'k1' }, '192.0.2.1')).toBe(sha('k1'));
  });

  it('runs one more load when asked to refresh during a load, and none after destroy', async () => {
    let rows = [row('k1')];
    const { index, find } = indexOver(() => Promise.resolve(rows));
    await index.onApplicationBootstrap();
    expect(find).toHaveBeenCalledTimes(1);

    rows = [row('k2')];
    index.refreshSoon();
    index.refreshSoon();
    index.refreshSoon();
    await (index as unknown as { loading: Promise<void> }).loading;
    expect(find).toHaveBeenCalledTimes(3);
    expect(index.recognise({ 'x-api-key': 'k2' }, '192.0.2.1')).toBe(sha('k2'));
    expect(index.recognise({ 'x-api-key': 'k1' }, '192.0.2.1')).toBeUndefined();

    index.onModuleDestroy();
    index.refreshSoon();
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('refreshes on an interval until destroyed', async () => {
    jest.useFakeTimers();
    const { index, find } = indexOver([row('k1')]);
    await index.onApplicationBootstrap();
    expect(find).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(find).toHaveBeenCalledTimes(2);

    index.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
