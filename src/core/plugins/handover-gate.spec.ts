import { shouldDispatchToPlugin } from './handover-gate';

describe('shouldDispatchToPlugin', () => {
  it('dispatches when there is no handover row (bot is default)', () => {
    expect(shouldDispatchToPlugin(null, 'faq-bot')).toBe(true);
  });
  it('dispatches while the conversation is bot-handled', () => {
    expect(shouldDispatchToPlugin({ pluginId: 'chatwoot-adapter', handoverState: 'bot' }, 'faq-bot')).toBe(true);
  });
  it('silences OTHER bots when the owner has taken over (human)', () => {
    expect(shouldDispatchToPlugin({ pluginId: 'chatwoot-adapter', handoverState: 'human' }, 'faq-bot')).toBe(false);
  });
  it('silences OTHER bots when the conversation is closed', () => {
    expect(shouldDispatchToPlugin({ pluginId: 'chatwoot-adapter', handoverState: 'closed' }, 'faq-bot')).toBe(false);
  });
  it('exempts the owning plugin so the relay keeps mirroring', () => {
    expect(shouldDispatchToPlugin({ pluginId: 'chatwoot-adapter', handoverState: 'human' }, 'chatwoot-adapter')).toBe(
      true,
    );
  });
});
