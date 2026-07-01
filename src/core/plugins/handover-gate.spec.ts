import { shouldDispatchInbound } from './handover-gate';

describe('shouldDispatchInbound', () => {
  it('dispatches when there is no mapping (bot is default)', () => {
    expect(shouldDispatchInbound(null)).toBe(true);
  });
  it('dispatches for a bot conversation', () => {
    expect(shouldDispatchInbound({ handoverState: 'bot' } as never)).toBe(true);
  });
  it('does NOT dispatch to the bot for a human-handled conversation', () => {
    expect(shouldDispatchInbound({ handoverState: 'human' } as never)).toBe(false);
  });
  it('does NOT dispatch for a closed conversation', () => {
    expect(shouldDispatchInbound({ handoverState: 'closed' } as never)).toBe(false);
  });
});
