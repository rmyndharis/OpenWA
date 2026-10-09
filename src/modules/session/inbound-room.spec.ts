import { InboundRoom, deferred, roomState, type RoomState } from './inbound-room';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('InboundRoom', () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '2';
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '1000';
  });

  afterEach(() => {
    process.env = { ...env };
    jest.useRealTimers();
  });

  const requested = (room: InboundRoom, n: number): RoomState[] =>
    Array.from({ length: n }, () => {
      const s = roomState();
      void room.request(s);
      return s;
    });

  it('grants free slots synchronously and the rest in request order', async () => {
    const room = new InboundRoom();
    const [a, b, c, d] = requested(room, 4);

    expect([a.granted, b.granted, c.granted, d.granted]).toEqual([true, true, false, false]);

    b.done.resolve();
    await flush();
    expect([c.granted, d.granted]).toEqual([true, false]);

    a.done.resolve();
    await flush();
    expect(d.granted).toBe(true);
  });

  it('holds a slot until done and every hold settle, including a hold pushed after the grant', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const room = new InboundRoom();
    const [a, b] = requested(room, 2);
    const engine = deferred<void>();
    const page = deferred<void>();
    a.holds.push(engine.promise);

    a.done.resolve();
    await flush();
    expect(b.granted).toBe(false);

    // Pushed while the earlier hold still runs (a page download outliving the emit).
    a.holds.push(page.promise);
    engine.resolve();
    await flush();
    expect(b.granted).toBe(false);

    page.resolve();
    await flush();
    expect(b.granted).toBe(true);
  });

  it('keeps a waiter waiting while the room makes progress, and gives up only once it stalls', async () => {
    jest.useFakeTimers();
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const room = new InboundRoom();
    const holders = requested(room, 3);
    const waiter = roomState();
    void room.request(waiter);
    let answer: boolean | undefined;
    void room.wait(waiter).then(v => (answer = v));

    // The window is twice MEDIA_DOWNLOAD_TIMEOUT_MS; each release restarts it.
    for (const holder of holders) {
      await jest.advanceTimersByTimeAsync(1500);
      holder.done.resolve();
      await flush();
    }
    await flush();
    expect(answer).toBe(true);

    const stalled = roomState();
    void room.request(stalled);
    let late: boolean | undefined;
    void room.wait(stalled).then(v => (late = v));
    await jest.advanceTimersByTimeAsync(1999);
    expect(late).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(late).toBe(false);
    expect(stalled.abandoned).toBe(true);
  });

  it('lets an abandoned request pass its slot straight on', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const room = new InboundRoom();
    const [a, b, c] = requested(room, 3);
    b.abandoned = true;

    a.done.resolve();
    await flush();

    expect(b.granted).toBe(false);
    expect(c.granted).toBe(true);
    expect(room.gate.activeCount).toBe(1);
  });

  it('is idle once every slot came back', async () => {
    const room = new InboundRoom();
    const [a] = requested(room, 1);
    expect(room.idle).toBe(false);
    a.done.resolve();
    await flush();
    expect(room.idle).toBe(true);
  });
});
