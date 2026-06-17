// src/modules/translation/core/translation.coordinator.spec.ts
import { TranslationCoordinator, CoordinatorOptions } from './translation.coordinator';
import { ChatGateway, ConfigStore, GroupState, InboundMessage, Translator } from './ports';

const OPTS: CoordinatorOptions = { prefix: '/tr', minLength: 2, maxLength: 2000, denyReply: false };

function freshState(over: Partial<GroupState> = {}): GroupState {
  return {
    sessionId: 's',
    chatId: 'g@g.us',
    active: false,
    participants: {},
    delegatedControllers: [],
    announced: false,
    ...over,
  };
}

function makeDeps(state: GroupState) {
  const saved: GroupState[] = [];
  const load = jest.fn().mockResolvedValue(state);
  const save = jest.fn().mockImplementation((s: GroupState) => {
    saved.push(JSON.parse(JSON.stringify(s)) as GroupState);
    return Promise.resolve();
  });
  const sendText = jest.fn().mockResolvedValue(undefined);
  const sendCombinedReply = jest.fn().mockResolvedValue(undefined);
  const getGroupAdmins = jest.fn().mockResolvedValue([]);
  const detect = jest.fn();
  const translate = jest.fn();
  const languages = jest.fn().mockResolvedValue(['en', 'es', 'fr']);
  const isHealthy = jest.fn().mockReturnValue(true);

  const store: ConfigStore = { load, save };
  const gateway: ChatGateway = { sendText, sendCombinedReply, getGroupAdmins };
  const translator: Translator = { detect, translate, languages, isHealthy };

  return {
    store,
    gateway,
    translator,
    saved,
    mocks: { load, save, sendText, sendCombinedReply, getGroupAdmins, detect, translate, languages, isHealthy },
  };
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'M1',
    chatId: 'g@g.us',
    body: 'hello',
    author: '111@c.us',
    isGroup: true,
    fromMe: false,
    mentionedIds: [],
    ...over,
  };
}

describe('TranslationCoordinator', () => {
  it('ignores non-group and fromMe messages', async () => {
    const { store, gateway, translator, mocks } = makeDeps(freshState());
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    expect(await c.handleMessage('s', msg({ isGroup: false }))).toEqual({ swallow: false });
    expect(await c.handleMessage('s', msg({ fromMe: true }))).toEqual({ swallow: false });
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('announces once on first contact then stays dormant', async () => {
    const { store, gateway, translator, mocks } = makeDeps(freshState());
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg());
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalled();
  });

  it('activates only for an admin', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ body: '/tr on' }));
    expect(res).toEqual({ swallow: true });
    expect(saved.at(-1)?.active).toBe(true);
  });

  it('rejects activation from a non-admin (silent by default)', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['999@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ body: '/tr on' }));
    expect(res).toEqual({ swallow: true });
    expect(saved.at(-1)?.active ?? false).toBe(false);
  });

  it('translates an active-group message into other participants languages (skipping the source)', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockResolvedValue('Hola');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ author: '111@c.us', body: 'Hello' }));
    expect(res).toEqual({ swallow: false });
    expect(mocks.translate).toHaveBeenCalledWith('Hello', 'en', 'es');
    expect(mocks.sendCombinedReply).toHaveBeenCalledWith('s', 'g@g.us', 'M1', expect.stringContaining('Hola'));
  });

  it('falls back to the sender language and never translates into the source when detection misfires', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 3, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'pinned', enabled: true, samples: 3, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, mocks } = makeDeps(state);
    // Detection misfires on colloquial Spanish, returning 'gl' — a language the group does not use.
    mocks.detect.mockResolvedValue({ lang: 'gl', confidence: 0.5 });
    mocks.translate.mockResolvedValue('Let me know');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ author: '222@c.us', body: 'Haber dime que debo darte' }));
    // Effective source falls back to the sender's known 'es'; 'en' is the only target.
    expect(mocks.translate).toHaveBeenCalledTimes(1);
    expect(mocks.translate).toHaveBeenCalledWith('Haber dime que debo darte', 'es', 'en');
    // Must never translate a message into the sender's own language.
    expect(mocks.translate).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'es');
  });

  it('learns a sender language only after a 2-message debounce', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 5, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'fr', confidence: 0.99 });
    mocks.translate.mockResolvedValue('x');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    // First foreign detection: lang stays 'en'
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Bonjour' }));
    expect(saved.at(-1)?.participants['111@c.us'].lang).toBe('en');
    // Second consecutive foreign detection: switches to 'fr'
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Salut' }));
    expect(saved.at(-1)?.participants['111@c.us'].lang).toBe('fr');
  });

  it('skips trivial messages below minLength', async () => {
    const state = freshState({ announced: true, active: true });
    const { store, gateway, translator, mocks } = makeDeps(state);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ body: '.' }));
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(mocks.sendCombinedReply).not.toHaveBeenCalled();
  });
});
