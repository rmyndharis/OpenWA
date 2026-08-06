import { PresenceStore } from './presence-store.service';
import type { PresenceUpdateEvent } from '../../engine/interfaces/whatsapp-engine.interface';

const event = (over: Partial<PresenceUpdateEvent> = {}): PresenceUpdateEvent => ({
  chatId: 'c@c.us',
  participants: [{ id: 'c@c.us', state: 'composing' }],
  ...over,
});

describe('PresenceStore', () => {
  let store: PresenceStore;

  beforeEach(() => {
    store = new PresenceStore();
  });

  describe('change detection', () => {
    // The load-bearing behaviour. WhatsApp reports presence on every transition and repeats itself
    // freely; without suppression one watched chat with an active typist buries every other event a
    // consumer subscribes to.
    it('reports the first observation as a change', () => {
      expect(store.record('s1', event())).toBe(true);
    });

    it('suppresses an identical repeat', () => {
      store.record('s1', event());

      expect(store.record('s1', event())).toBe(false);
      expect(store.record('s1', event())).toBe(false);
    });

    it('reports a state transition', () => {
      store.record('s1', event({ participants: [{ id: 'c@c.us', state: 'composing' }] }));

      expect(store.record('s1', event({ participants: [{ id: 'c@c.us', state: 'paused' }] }))).toBe(true);
    });

    it('reports a participant appearing or disappearing', () => {
      store.record('s1', event({ participants: [{ id: 'a@c.us', state: 'available' }] }));

      expect(
        store.record(
          's1',
          event({
            participants: [
              { id: 'a@c.us', state: 'available' },
              { id: 'b@c.us', state: 'available' },
            ],
          }),
        ),
      ).toBe(true);
    });

    // The engines build the participant list by iterating an object, so ordering is incidental.
    // Treating a reordering as news would defeat the suppression on exactly the busy group chats
    // where it matters most.
    it('ignores participant ordering', () => {
      const participants = [
        { id: 'a@c.us', state: 'available' as const },
        { id: 'b@c.us', state: 'composing' as const },
      ];
      store.record('s1', event({ participants }));

      expect(store.record('s1', event({ participants: [...participants].reverse() }))).toBe(false);
    });

    // lastSeen advances continuously while nothing observable happens; if it counted as a change the
    // suppression would never suppress anything.
    it('ignores lastSeen drift on an unchanged state', () => {
      store.record('s1', event({ participants: [{ id: 'c@c.us', state: 'available', lastSeen: 1000 }] }));

      expect(store.record('s1', event({ participants: [{ id: 'c@c.us', state: 'available', lastSeen: 2000 }] }))).toBe(
        false,
      );
    });

    it('ignores groupOnlineCount drift on an unchanged state', () => {
      store.record('s1', event({ groupOnlineCount: 3 }));

      expect(store.record('s1', event({ groupOnlineCount: 9 }))).toBe(false);
    });

    it('tracks chats and sessions independently', () => {
      store.record('s1', event({ chatId: 'a@c.us' }));

      expect(store.record('s1', event({ chatId: 'b@c.us' }))).toBe(true);
      expect(store.record('s2', event({ chatId: 'a@c.us' }))).toBe(true);
    });
  });

  describe('reads', () => {
    it('serves the last report with when it arrived', () => {
      store.record('s1', event({ groupOnlineCount: 2 }), 1_700_000_000_000);

      expect(store.get('s1', 'c@c.us')).toEqual({
        chatId: 'c@c.us',
        participants: [{ id: 'c@c.us', state: 'composing' }],
        groupOnlineCount: 2,
        observedAt: 1_700_000_000_000,
      });
    });

    // A suppressed repeat still refreshes what is served, so a read never reports a state as older
    // than it really is just because it stopped changing.
    it('refreshes the stored report even when the change was suppressed', () => {
      store.record('s1', event(), 1000);
      store.record('s1', event(), 5000);

      expect(store.get('s1', 'c@c.us')?.observedAt).toBe(5000);
    });

    // "Nothing reported yet" is a normal state — subscribed but quiet — not a missing resource.
    it('returns null for a chat nothing was reported for', () => {
      expect(store.get('s1', 'unknown@c.us')).toBeNull();
    });

    it('returns null for an unknown session', () => {
      expect(store.get('nobody', 'c@c.us')).toBeNull();
    });
  });

  describe('clearing', () => {
    it('drops everything for the session', () => {
      store.record('s1', event({ chatId: 'a@c.us' }));
      store.record('s1', event({ chatId: 'b@c.us' }));
      store.record('s2', event({ chatId: 'a@c.us' }));

      store.clear('s1');

      expect(store.get('s1', 'a@c.us')).toBeNull();
      expect(store.get('s1', 'b@c.us')).toBeNull();
      // …and leaves other sessions alone.
      expect(store.get('s2', 'a@c.us')).not.toBeNull();
    });

    // After a clear the next report is news again — otherwise a restarted session would stay silent
    // until the contact happened to change state.
    it('makes the next report a change again', () => {
      store.record('s1', event());
      store.clear('s1');

      expect(store.record('s1', event())).toBe(true);
    });
  });

  // Presence is only reported for chats a caller explicitly subscribed, so the map is already
  // caller-bounded; the cap is there so a client that subscribes in a loop cannot grow it forever.
  it('evicts the least recently observed chat past the cap', () => {
    for (let i = 0; i < 501; i++) store.record('s1', event({ chatId: `chat-${i}@c.us` }), 1000 + i);

    expect(store.get('s1', 'chat-0@c.us')).toBeNull();
    expect(store.get('s1', 'chat-500@c.us')).not.toBeNull();
  });

  it('keeps a chat alive by re-observing it', () => {
    store.record('s1', event({ chatId: 'kept@c.us' }), 1);
    for (let i = 0; i < 499; i++) store.record('s1', event({ chatId: `chat-${i}@c.us` }), 100 + i);
    // Re-observing moves it to the newest position, so the next eviction takes something else.
    store.record('s1', event({ chatId: 'kept@c.us', participants: [{ id: 'x@c.us', state: 'paused' }] }), 9000);
    store.record('s1', event({ chatId: 'overflow@c.us' }), 9001);

    expect(store.get('s1', 'kept@c.us')).not.toBeNull();
    expect(store.get('s1', 'chat-0@c.us')).toBeNull();
  });
});
