import { DataSource, Repository } from 'typeorm';
import { ChatState } from './baileys-chat-state.entity';
import { ChatStateStoreService, type KeptChatStateWrite } from './baileys-chat-state-store.service';

const SID = 'session-a';
const PHONE = '22222@s.whatsapp.net';
const LID = '11111@lid';

describe('Chat state after a failed write', () => {
  let db: DataSource;
  let repo: Repository<ChatState>;
  let states: ChatStateStoreService;

  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [ChatState], synchronize: true });
    await db.initialize();
    repo = db.getRepository(ChatState);
    states = new ChatStateStoreService(repo);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });

  const seed = (chatId: string) =>
    repo.upsert(
      { sessionId: SID, chatId, muteEndTime: -1, pinned: true, archived: false, observed: 'muteEndTime,pinned' },
      ['sessionId', 'chatId'],
    );
  const cold = async () => {
    const store = new ChatStateStoreService(repo);
    await store.refreshSession(SID);
    return store;
  };

  it('writes an identical fold again when the first write failed', async () => {
    await seed(LID);
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await states.fold(SID, PHONE, [LID], { archived: true });
    expect(await repo.findOneBy({ sessionId: SID, chatId: LID })).not.toBeNull();

    await states.fold(SID, PHONE, [LID], { archived: true });

    expect((await cold()).get(SID, PHONE)).toMatchObject({ muteEndTime: -1, pinned: true, archived: true });
    expect(await repo.findOneBy({ sessionId: SID, chatId: LID })).toBeNull();
  });

  it('keeps the twin row while the repeated fold keeps failing', async () => {
    await seed(LID);
    jest
      .spyOn(repo, 'upsert')
      .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
      .mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await states.fold(SID, PHONE, [LID], { archived: true });
    await states.fold(SID, PHONE, [LID], { archived: true });

    const store = await cold();
    expect(store.get(SID, LID)).toMatchObject({ muteEndTime: -1, pinned: true, archived: false });
    expect(store.get(SID, PHONE)).toBeUndefined();
  });

  it('writes an identical patch again when the first write failed', async () => {
    await seed(PHONE);
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await states.remember(SID, PHONE, { archived: true });
    await states.remember(SID, PHONE, { archived: true });

    expect((await cold()).get(SID, PHONE)).toMatchObject({ muteEndTime: -1, pinned: true, archived: true });
  });
});

describe('Chat states cleared up to an unlink, on a real table', () => {
  it('deletes the rows written up to that time and leaves those written after it', async () => {
    const db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ChatState],
      synchronize: true,
    });
    await db.initialize();
    try {
      const repo = db.getRepository(ChatState);
      await repo.upsert({ sessionId: SID, chatId: 'old', pinned: true, updatedAt: new Date(1_786_000_000_000) }, [
        'sessionId',
        'chatId',
      ]);
      await repo.upsert({ sessionId: SID, chatId: 'new', archived: true, updatedAt: new Date(1_786_000_002_000) }, [
        'sessionId',
        'chatId',
      ]);

      await new ChatStateStoreService(repo).clearSession(SID, new Date(1_786_000_001_000));

      expect((await repo.find({ where: { sessionId: SID } })).map(row => row.chatId)).toEqual(['new']);
    } finally {
      await db.destroy();
    }
  });
});

describe('Chat states of the next account while an unlink clear is kept', () => {
  let db: DataSource;
  let repo: Repository<ChatState>;
  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [ChatState], synchronize: true });
    await db.initialize();
    repo = db.getRepository(ChatState);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });
  const turns = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  };
  const unavailable = (): Error => Object.assign(new Error('Connection terminated'), { code: 'ECONNREFUSED' });

  it("reads the next account's pin once the kept clear lands, the session's cache no longer taken as whole", async () => {
    await repo.upsert({ sessionId: SID, chatId: 'old', pinned: true, updatedAt: new Date(1_000) }, [
      'sessionId',
      'chatId',
    ]);
    const store = new ChatStateStoreService(repo);
    await store.reload();
    jest.spyOn(repo, 'delete').mockRejectedValueOnce(unavailable());
    await expect(store.clearSession(SID)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    const cutoff = new Date(2_000);
    store.hideUpTo(SID, cutoff);
    await store.remember(SID, 'new', { pinned: true });

    await store.clearSession(SID, new Date(cutoff.getTime()));
    store.get(SID, 'new');
    await turns();

    expect(store.get(SID, 'new')).toMatchObject({ pinned: true });
    expect(store.get(SID, 'old')).toBeUndefined();
  });

  it('lifts the fence once the kept clear lands, whatever Date it is handed', async () => {
    const store = new ChatStateStoreService(repo);
    store.hideUpTo(SID, new Date(2_000));
    await store.clearSession(SID, new Date(2_000));
    // A restore brings an older row of the session back afterwards: it is not hidden any more.
    await repo.upsert({ sessionId: SID, chatId: 'restored', archived: true, updatedAt: new Date(1_000) }, [
      'sessionId',
      'chatId',
    ]);

    await store.refreshSession(SID);

    expect(store.get(SID, 'restored')).toMatchObject({ archived: true });
  });
});

describe('A chat state write the database refused', () => {
  let db: DataSource;
  let repo: Repository<ChatState>;
  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [ChatState], synchronize: true });
    await db.initialize();
    repo = db.getRepository(ChatState);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });
  const unavailable = (): Error => Object.assign(new Error('Connection terminated'), { code: 'ECONNREFUSED' });
  const row = (chatId: string) => repo.findOneBy({ sessionId: SID, chatId });

  it('is handed on to keep, and replayed once the database answers', async () => {
    const store = new ChatStateStoreService(repo);
    const kept: KeptChatStateWrite[] = [];
    store.onRefusedWrite(write => kept.push(write));
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(unavailable());

    await store.remember(SID, PHONE, { pinned: true });
    expect(kept).toHaveLength(1);
    expect(await row(PHONE)).toBeNull();

    await store.replayWrite(JSON.parse(JSON.stringify(kept[0])) as KeptChatStateWrite);

    expect(await row(PHONE)).toMatchObject({ pinned: true });
  });

  it('leaves a newer live write standing when the older kept one is replayed after it', async () => {
    const store = new ChatStateStoreService(repo);
    const kept: KeptChatStateWrite[] = [];
    store.onRefusedWrite(write => kept.push(write));
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(unavailable());
    await store.remember(SID, PHONE, { pinned: true });
    await store.remember(SID, PHONE, { pinned: false, archived: true });

    await store.replayWrite(kept[0]);

    expect(await row(PHONE)).toMatchObject({ pinned: false, archived: true });
  });

  it('replays a write made blind, its row unreadable, carrying only what it patched', async () => {
    await repo.upsert({ sessionId: SID, chatId: PHONE, muteEndTime: -1, updatedAt: new Date(1_000) }, [
      'sessionId',
      'chatId',
    ]);
    const store = new ChatStateStoreService(repo);
    const kept: KeptChatStateWrite[] = [];
    store.onRefusedWrite(write => kept.push(write));
    jest.spyOn(repo, 'findOne').mockRejectedValueOnce(unavailable());
    jest.spyOn(repo, 'update').mockRejectedValueOnce(unavailable());

    await store.remember(SID, PHONE, { archived: true });
    expect(kept).toHaveLength(1);
    await store.replayWrite(kept[0]);

    expect(await row(PHONE)).toMatchObject({ muteEndTime: -1, archived: true });
  });

  it('is not replayed when the account that made it was unlinked since, its clear kept', async () => {
    const store = new ChatStateStoreService(repo);
    store.hideUpTo(SID, new Date(5_000));

    await store.replayWrite({ sessionId: SID, chatId: PHONE, columns: { pinned: true }, create: true, at: 4_000 });

    expect(await row(PHONE)).toBeNull();
  });

  it('keeps nothing of a write refused for a reason of its own', async () => {
    const store = new ChatStateStoreService(repo);
    const kept: KeptChatStateWrite[] = [];
    store.onRefusedWrite(write => kept.push(write));
    jest
      .spyOn(repo, 'upsert')
      .mockRejectedValueOnce(Object.assign(new Error('CHECK constraint failed'), { code: 'SQLITE_CONSTRAINT_CHECK' }));

    await store.remember(SID, PHONE, { pinned: true });

    expect(kept).toEqual([]);
  });
});

describe('Chat states an unlinked account left, hidden while its clear is kept', () => {
  let db: DataSource;
  let repo: Repository<ChatState>;
  const hiddenUpTo = new Date(2_000);
  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [ChatState], synchronize: true });
    await db.initialize();
    repo = db.getRepository(ChatState);
    // The old account's rows, written before the unlink.
    await repo.upsert(
      {
        sessionId: SID,
        chatId: LID,
        pinned: true,
        muteEndTime: -1,
        observed: 'muteEndTime,pinned',
        updatedAt: new Date(1_000),
      },
      ['sessionId', 'chatId'],
    );
    await repo.upsert(
      {
        sessionId: SID,
        chatId: PHONE,
        pinned: true,
        muteEndTime: -1,
        observed: 'muteEndTime,pinned',
        updatedAt: new Date(1_000),
      },
      ['sessionId', 'chatId'],
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });
  const fresh = (): ChatStateStoreService => {
    const store = new ChatStateStoreService(repo);
    store.hideUpTo(SID, hiddenUpTo);
    return store;
  };
  const turns = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  };

  it('are not warmed into the cache by a miss', async () => {
    const store = fresh();
    store.get(SID, PHONE);
    await turns();

    expect(store.get(SID, PHONE)).toBeUndefined();
  });

  it('are not loaded by a refresh of the session', async () => {
    const store = fresh();
    await store.refreshSession(SID);

    expect(store.get(SID, PHONE)).toBeUndefined();
  });

  it('are not the base a write of the next account merges onto', async () => {
    const store = fresh();
    await store.remember(SID, PHONE, { archived: true });

    expect(await repo.findOneBy({ sessionId: SID, chatId: PHONE })).toMatchObject({
      archived: true,
      pinned: false,
      muteEndTime: null,
    });
  });

  it('are not folded from a twin into the chat of the next account', async () => {
    await repo.delete({ sessionId: SID, chatId: PHONE });
    const store = fresh();
    await store.fold(SID, PHONE, [LID], { archived: true });

    expect(await repo.findOneBy({ sessionId: SID, chatId: PHONE })).toMatchObject({ archived: true, pinned: false });
  });
});
