import { isKnownHookEvent, KNOWN_HOOK_EVENTS } from './hook.interfaces';

describe('message:persisted hook event', () => {
  it('is a known event', () => {
    expect(isKnownHookEvent('message:persisted')).toBe(true);
    expect(KNOWN_HOOK_EVENTS.has('message:persisted')).toBe(true);
  });
});

describe('message:deleted hook event', () => {
  it('is a known event (search providers reconcile dropped rows via it, #906)', () => {
    expect(isKnownHookEvent('message:deleted')).toBe(true);
    expect(KNOWN_HOOK_EVENTS.has('message:deleted')).toBe(true);
  });
});
