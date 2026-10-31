import { DataSource, Repository } from 'typeorm';
import { ChatState } from './baileys-chat-state.entity';
import { ChatStateStoreService } from './baileys-chat-state-store.service';

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
