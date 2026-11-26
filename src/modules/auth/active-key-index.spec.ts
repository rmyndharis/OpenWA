import { createHash, createHmac } from 'crypto';
import { Repository } from 'typeorm';
import { ActiveKeyIndex } from './active-key-index';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

const sha = (key: string) => createHash('sha256').update(key).digest('hex');

type Row = Pick<ApiKey, 'keyHash' | 'allowedIps' | 'expiresAt'> &
  Partial<Pick<ApiKey, 'id' | 'role' | 'allowedSessions' | 'allowedChats'>>;

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
  // It runs for a request nothing has authenticated or throttled yet, so callers cannot make it read in a loop.
  it('refresh() forces at most one reload a second', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { index, find } = indexOver([row('k1')]);
    await index.onApplicationBootstrap();
    index.onModuleDestroy();
    (index as unknown as { destroyed: boolean }).destroyed = false;
    find.mockClear();
    try {
      await index.refresh();
      now.mockReturnValue(1_000_999);
      await index.refresh();
      expect(find).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_001_000);
      await index.refresh();
      expect(find).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  // The import guard waits on this: the view it then reads has every key written before it asked.
  it('refresh() resolves with a view that holds a key written while an earlier load was running', async () => {
    const rows: Row[] = [row('k1')];
    let release!: () => void;
    let loads = 0;
    const { index } = indexOver(async () => {
      const snapshot = [...rows];
      if (loads++ === 1) await new Promise<void>(resolve => (release = resolve));
      return snapshot;
    });
    await index.onApplicationBootstrap();
    index.onModuleDestroy();
    (index as unknown as { destroyed: boolean }).destroyed = false;
    index.refreshSoon();
    rows.push(row('k2'));
    const refreshed = index.refresh();
    release();
    await refreshed;

    expect(index.recognise({ 'x-api-key': 'k2' }, '192.0.2.1')).toBe(sha('k2'));
  });

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

  it('names as an unscoped admin only an admin key that no session or chat restriction limits', async () => {
    const { index } = indexOver([
      row('admin', { role: ApiKeyRole.ADMIN }),
      row('operator', { role: ApiKeyRole.OPERATOR }),
      row('viewer', { role: ApiKeyRole.VIEWER }),
      row('one-session', { role: ApiKeyRole.ADMIN, allowedSessions: ['s1'] }),
      row('one-chat', { role: ApiKeyRole.ADMIN, allowedChats: ['628@c.us'] }),
      row('empty-lists', { role: ApiKeyRole.ADMIN, allowedSessions: [], allowedChats: [] }),
    ]);
    await index.onApplicationBootstrap();
    index.onModuleDestroy();
    const asked = (key: string) => index.isUnscopedAdmin({ 'x-api-key': key }, '192.0.2.1');

    expect(['admin', 'empty-lists'].map(asked)).toEqual([true, true]);
    expect(['operator', 'viewer', 'one-session', 'one-chat', 'nope'].map(asked)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    // Still a recognised key for the body budget, whatever its role.
    expect(index.recognise({ 'x-api-key': 'viewer' }, '192.0.2.1')).toBe(sha('viewer'));
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

  it('treats a stored expiry that reads back as an invalid date as expired, as validateApiKey does', async () => {
    const { index } = indexOver([row('garbled', { expiresAt: new Date('2020-W01-1') })]);
    await index.onApplicationBootstrap();
    index.onModuleDestroy();
    expect(index.recognise({ 'x-api-key': 'garbled' }, '192.0.2.1')).toBeUndefined();
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

  it('recovers and populates the index when an initial bootstrap read fails transiently', async () => {
    let attempts = 0;
    const { index } = indexOver(() => {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('transient bootstrap db connection error'));
      return Promise.resolve([row('k-bootstrap')]);
    });

    // Initial bootstrap load fails transiently; index stays empty without throwing
    await index.onApplicationBootstrap();
    expect(index.recognise({ 'x-api-key': 'k-bootstrap' }, '192.0.2.1')).toBeUndefined();

    // Extra refresh (e.g. from seedApiKey bootstrap resilience) attempts reload
    index.refreshSoon();
    await (index as unknown as { loading: Promise<void> }).loading;
    index.onModuleDestroy();

    // Now populated successfully
    expect(index.recognise({ 'x-api-key': 'k-bootstrap' }, '192.0.2.1')).toBe(sha('k-bootstrap'));
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

  it('never drops a refresh requested as the running load finishes', async () => {
    // A write's continuation can run in any microtask around the end of the running load; each
    // depth must still get the load after the one in flight.
    for (let depth = 0; depth < 8; depth++) {
      let calls = 0;
      const { index, find } = indexOver(() => {
        calls++;
        if (calls === 2) {
          let hop: Promise<void> = Promise.resolve();
          for (let i = 0; i < depth; i++) hop = hop.then(() => undefined);
          void hop.then(() => index.refreshSoon());
        }
        return Promise.resolve([row('k1')]);
      });
      await index.onApplicationBootstrap();
      index.refreshSoon();
      await new Promise(resolve => setImmediate(resolve));
      index.onModuleDestroy();
      expect({ depth, loads: find.mock.calls.length }).toEqual({ depth, loads: 3 });
    }
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

  it('recognises active browser session cookies for pre-body-parser keyed classification except on header-only paths', async () => {
    const keyRow = { id: 'key-1', ...row('k1', { allowedIps: ['10.0.0.1'] }) };
    const sessionToken = 'browser-session-tok-1';
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([
        {
          tokenHash: sha(sessionToken),
          apiKeyId: 'key-1',
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        },
      ]),
    };
    const keyRepo = { find: jest.fn().mockResolvedValue([keyRow]) };
    const IndexCtor = ActiveKeyIndex as unknown as new (...args: unknown[]) => ActiveKeyIndex;
    const index = new IndexCtor(keyRepo, sessionRepo);
    await index.onApplicationBootstrap();
    try {
      expect(index.recognise({ cookie: `openwa_session=${sessionToken}` }, '10.0.0.1', '/api/infra/import-data')).toBe(
        sha('k1'),
      );
      expect(
        index.recognise({ cookie: `openwa_session=${sessionToken}` }, '10.0.0.99', '/api/infra/import-data'),
      ).toBeUndefined();
      expect(index.recognise({ cookie: `openwa_session=${sessionToken}` }, '10.0.0.1', '/mcp')).toBeUndefined();
      expect(index.recognise({ cookie: `openwa_session=${sessionToken}` }, '10.0.0.1', '/api/metrics')).toBeUndefined();
      expect(
        index.recognise({ cookie: `openwa_session=${sessionToken}` }, '10.0.0.1', '/api/admin/queues'),
      ).toBeUndefined();
      // Header precedence: invalid or whitespace-only X-API-Key does not fall back to a valid cookie.
      expect(
        index.recognise(
          { 'x-api-key': 'wrong', cookie: `openwa_session=${sessionToken}` },
          '10.0.0.1',
          '/api/sessions',
        ),
      ).toBeUndefined();
      expect(
        index.recognise({ 'x-api-key': '   ', cookie: `openwa_session=${sessionToken}` }, '10.0.0.1', '/api/sessions'),
      ).toBeUndefined();
      // ActiveKeyIndex.load() filters out expired rows at query time (expiresAt > now).
      const findCalls = sessionRepo.find.mock.calls as Array<Array<{ where?: { expiresAt?: unknown } }>>;
      expect(findCalls[0]?.[0]?.where?.expiresAt).toBeDefined();
    } finally {
      index.onModuleDestroy();
    }
  });
});
