import { readLeanContacts } from './wwebjs-contacts';

/**
 * readLeanContacts runs inside the WhatsApp Web page (page.evaluate), so these drive it against a
 * stand-in `window` rather than through the adapter, where the evaluate is mocked away.
 */
describe('readLeanContacts (in-page contact walk)', () => {
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
    jest.restoreAllMocks();
  });

  function withModels(models: string[], getContactModel: (m: string) => unknown): void {
    g.window = {
      require: () => ({ Contact: { getModelsArray: () => models } }),
      WWebJS: { getContactModel },
    };
  }

  const row = (m: string) => ({
    id: `${m}@c.us`,
    name: m,
    pushname: m,
    userid: m,
    isMyContact: true,
    isBlocked: false,
  });

  it('skips a model WhatsApp Web cannot read and keeps the rest (#1720)', async () => {
    withModels(['111', 'device', '222'], m => {
      if (m === 'device') throw new Error('getAlternateUserWid - Invalid get call using deviceWid');
      return row(m);
    });

    await expect(readLeanContacts()).resolves.toEqual({
      rows: [
        { id: '111@c.us', name: '111', pushname: '111', number: '111', isMyContact: true, isBlocked: false },
        { id: '222@c.us', name: '222', pushname: '222', number: '222', isMyContact: true, isBlocked: false },
      ],
      failed: 1,
      firstError: 'getAlternateUserWid - Invalid get call using deviceWid',
    });
  });

  it('walks the contact list as it stood at the start, even if the store grows during a yield', async () => {
    const models = Array.from({ length: 300 }, (_, i) => String(i));
    const original = [...models];
    const read: string[] = [];
    withModels(models, m => {
      read.push(m);
      return row(m);
    });
    // A new contact lands at the front of WhatsApp Web's live array while the walk yields.
    const realSetTimeout = globalThis.setTimeout;
    jest.spyOn(globalThis, 'setTimeout').mockImplementationOnce((cb: () => void) => {
      models.unshift('new');
      return realSetTimeout(cb);
    });

    const result = await readLeanContacts();

    expect(read).toEqual(original);
    expect(result.rows.map(r => r.number)).toEqual(original);
  });

  it('still yields to the page event loop when the models throw (#1501)', async () => {
    withModels(
      Array.from({ length: 300 }, (_, i) => String(i)),
      () => {
        throw new Error('unreadable');
      },
    );
    const timers = jest.spyOn(globalThis, 'setTimeout');

    const read = await readLeanContacts();

    expect(read).toEqual({ rows: [], failed: 300, firstError: 'unreadable' });
    expect(timers).toHaveBeenCalledTimes(1);
  });
});
