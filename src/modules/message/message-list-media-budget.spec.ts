import 'reflect-metadata';
import { DataSource, FindManyOptions, Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { MessageService, spendInlineMediaBudget } from './message.service';
import { Message, MessageDirection } from './entities/message.entity';
import type { EngineRegistry } from '../../engine/engine-registry.service';
import type { MessageProjector } from '../session/message-projector.service';
import type { HookManager } from '../../core/hooks';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { SendPacingService } from './send-pacing.service';
import type { MessageSendService } from './message-send.service';

/**
 * The inline media budget bounds the response; these cases pin that it bounds the READ too. A page
 * used to be loaded whole (every row's base64 on the heap) and trimmed afterwards, so one request
 * for a media-heavy chat held every payload at once. Driven against a real SQLite schema because the
 * page is now picked by a raw id/length select, which only a real database can check.
 */
describe('message list reads inline media within the budget', () => {
  const SESSION = 's1';
  const MiB = 1024 * 1024;

  let ds: DataSource;
  let repository: Repository<Message>;
  let service: MessageService;
  let prevBudget: string | undefined;

  const payload = (bytes: number, fill = 'A'): string => fill.repeat(bytes);

  // Oldest first, one second apart, so the list (newest first) serves them in reverse.
  const seed = async (rows: Array<{ id: string; metadata: Record<string, unknown> | null; chatId?: string }>) => {
    for (const [i, row] of rows.entries()) {
      await repository.insert({
        id: row.id,
        sessionId: SESSION,
        chatId: row.chatId ?? 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        direction: MessageDirection.INCOMING,
        metadata: (row.metadata ?? undefined) as never,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
  };

  const media = (data: string, extra: Record<string, unknown> = {}) => ({
    media: { mimetype: 'image/jpeg', filename: 'a.jpg', data, ...extra },
  });

  /** What the list used to return: every row loaded, then trimmed. */
  const loadThenTrim = async (budget: number): Promise<Message[]> => {
    const rows = await repository.find({
      where: { sessionId: SESSION },
      order: { createdAt: 'DESC' },
    });
    return spendInlineMediaBudget(rows, budget);
  };

  const strip = (rows: Message[]) => rows.map(r => ({ id: r.id, metadata: r.metadata }));

  beforeEach(async () => {
    prevBudget = process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(Message);
    service = new MessageService(
      repository,
      {} as EngineRegistry,
      {} as MessageProjector,
      {} as HookManager,
      {
        findLidsForPhone: () => Promise.resolve([]),
        findPhoneForLid: () => Promise.resolve(null),
      } as unknown as LidMappingStoreService,
      {} as SendPacingService,
      {} as MessageSendService,
    );
  });

  afterEach(async () => {
    if (prevBudget === undefined) delete process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
    else process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = prevBudget;
    jest.restoreAllMocks();
    await ds.destroy();
  });

  /** Oldest to newest. The newest is a URL pointer, so the allowance must skip it. */
  const mixedPage = () => [
    { id: 'old-big-1', metadata: { ...media(payload(3 * MiB)), quotedMessage: { body: 'a\u0000b' } } },
    { id: 'old-big-2', metadata: media(payload(3 * MiB), { sizeBytes: 1234 }) },
    { id: 'text', metadata: null },
    { id: 'small', metadata: media(payload(40_000)) },
    { id: 'not-a-string', metadata: { media: { mimetype: 'image/jpeg', data: 42 } } },
    { id: 'big-3', metadata: media(payload(3 * MiB)) },
    { id: 'huge', metadata: media(payload(5 * MiB)) },
    { id: 'pointer', metadata: media('HTTPS://cdn.example/a.jpg') },
  ];

  it('returns exactly what loading the page and trimming it returned', async () => {
    process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = String(4 * MiB);
    await seed(mixedPage());
    const expected = strip(await loadThenTrim(4 * MiB));

    const { messages, total } = await service.getMessages(SESSION, { limit: 100 });

    expect(total).toBe(8);
    expect(strip(messages)).toEqual(expected);
    // Sanity on the fixture: the allowance let the newest payload through, the rest are markers.
    const byId = new Map(messages.map(m => [m.id, (m.metadata as { media?: Record<string, unknown> } | null)?.media]));
    expect(byId.get('pointer')?.data).toBe('HTTPS://cdn.example/a.jpg');
    expect(byId.get('huge')?.data).toHaveLength(5 * MiB);
    expect(byId.get('big-3')).toMatchObject({ omitted: true, mimetype: 'image/jpeg', filename: 'a.jpg' });
    expect(byId.get('old-big-2')).toMatchObject({ omitted: true, sizeBytes: 1234 });
    expect(messages.find(m => m.id === 'old-big-1')?.metadata).toMatchObject({ quotedMessage: { body: 'a\u0000b' } });
  });

  it('matches the old output with inlineMedia=false, where every payload is omitted', async () => {
    await seed(mixedPage());
    const expected = strip(await loadThenTrim(0));

    const { messages } = await service.getMessages(SESSION, { limit: 100, inlineMedia: false });

    expect(strip(messages)).toEqual(expected);
  });

  it('never loads more stored metadata at once than the budget or one row', async () => {
    const budget = 4 * MiB;
    process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = String(budget);
    await seed(Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, metadata: media(payload(3 * MiB)) })));
    const find = jest.spyOn(repository, 'find');

    const { messages } = await service.getMessages(SESSION, { limit: 100 });

    expect(messages).toHaveLength(10);
    const loads = find.mock.results.map(r => r.value as Promise<Message[]>);
    const perCall = await Promise.all(loads);
    for (const rows of perCall) {
      // With 3 MiB rows under a 4 MiB chunk bound, each read may hold one row, never the page.
      expect(rows.length).toBeLessThanOrEqual(1);
    }
    expect(perCall.length).toBe(10);
  });

  it('reads a page of plain text in one query', async () => {
    await seed(Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, metadata: null })));
    const find = jest.spyOn(repository, 'find');

    const { messages, total } = await service.getMessages(SESSION, { limit: 5, offset: 5 });

    expect(total).toBe(20);
    expect(messages.map(m => m.id)).toEqual(['t14', 't13', 't12', 't11', 't10']);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('serves the same rows through the `after` cursor and keeps the 400 on an unknown one', async () => {
    await seed(Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, metadata: media(payload(10)) })));

    const { messages, total } = await service.getMessages(SESSION, { limit: 2, after: 'c4' });

    expect(total).toBe(6);
    expect(messages.map(m => m.id)).toEqual(['c3', 'c2']);
    await expect(service.getMessages(SESSION, { after: 'nope' })).rejects.toThrow(BadRequestException);
  });

  it('applies the chat filter to the page and the total', async () => {
    await seed([
      { id: 'a1', metadata: null, chatId: 'a@c.us' },
      { id: 'b1', metadata: null, chatId: 'b@c.us' },
      { id: 'a2', metadata: null, chatId: 'a@c.us' },
    ]);

    const { messages, total } = await service.getMessages(SESSION, { chatId: 'a@c.us' });

    expect(total).toBe(2);
    expect(messages.map(m => m.id)).toEqual(['a2', 'a1']);
  });

  it('leaves out a row deleted after the page was picked', async () => {
    await seed([
      { id: 'keep', metadata: null },
      { id: 'gone', metadata: null },
    ]);
    const find = repository.find.bind(repository);
    jest.spyOn(repository, 'find').mockImplementation(async (options?: FindManyOptions<Message>) => {
      await repository.delete({ id: 'gone' });
      return find(options);
    });

    const { messages } = await service.getMessages(SESSION);

    expect(messages.map(m => m.id)).toEqual(['keep']);
  });
});
