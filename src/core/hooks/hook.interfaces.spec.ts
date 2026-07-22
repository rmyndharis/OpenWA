import { isKnownHookEvent, KNOWN_HOOK_EVENTS } from './hook.interfaces';

describe('message:persisted hook event', () => {
  it('is a known event', () => {
    expect(isKnownHookEvent('message:persisted')).toBe(true);
    expect(KNOWN_HOOK_EVENTS.has('message:persisted')).toBe(true);
  });
});

describe('message annotation hook events', () => {
  it('keeps the request and update lifecycle names in the finite sandbox allowlist', () => {
    expect(isKnownHookEvent('message:annotation-requested')).toBe(true);
    expect(isKnownHookEvent('message:annotation-updated')).toBe(true);
    expect(KNOWN_HOOK_EVENTS.has('message:annotation-requested')).toBe(true);
    expect(KNOWN_HOOK_EVENTS.has('message:annotation-updated')).toBe(true);
  });
});
