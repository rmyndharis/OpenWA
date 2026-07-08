import { isKnownHookEvent, KNOWN_HOOK_EVENTS } from './hook.interfaces';

describe('message:persisted hook event', () => {
  it('is a known event', () => {
    expect(isKnownHookEvent('message:persisted')).toBe(true);
    expect(KNOWN_HOOK_EVENTS.has('message:persisted')).toBe(true);
  });
});
