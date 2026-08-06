import { evaluateFilters } from './filter-evaluator';
import { WebhookFilters } from './filter-types';

const msg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  from: '111@c.us',
  to: '999@c.us',
  body: 'Hello World',
  type: 'text',
  fromMe: false,
  isGroup: false,
  ...over,
});

const filters = (...conditions: WebhookFilters['conditions']): WebhookFilters => ({ conditions });

describe('evaluateFilters', () => {
  it('passes when filters are absent or empty (additive/optional)', () => {
    expect(evaluateFilters(null, 'message.received', msg())).toBe(true);
    expect(evaluateFilters(undefined, 'message.received', msg())).toBe(true);
    expect(evaluateFilters(filters(), 'message.received', msg())).toBe(true);
  });

  it('matches sender by JID, case-insensitively', () => {
    const f = filters({ field: 'sender', operator: 'is', value: ['111@C.US'] });
    expect(evaluateFilters(f, 'message.received', msg())).toBe(true);
    expect(evaluateFilters(f, 'message.received', msg({ from: '222@c.us' }))).toBe(false);
  });

  it('matches a bare-digit phone filter against the engine JID across dialects (user-input canonicalization)', () => {
    // A user-typed phone (bare digits, optionally formatted) collapses to <digits>@c.us and matches the
    // sender whether the engine emitted @c.us or @s.whatsapp.net.
    const f = filters({ field: 'sender', operator: 'is', value: ['111'] });
    expect(evaluateFilters(f, 'message.received', msg({ from: '111@c.us' }))).toBe(true);
    expect(evaluateFilters(f, 'message.received', msg({ from: '111@s.whatsapp.net' }))).toBe(true);
    expect(evaluateFilters(f, 'message.received', msg({ from: '222@c.us' }))).toBe(false);

    // Formatting characters are stripped to digits before canonicalization.
    const formatted = filters({ field: 'sender', operator: 'is', value: ['+1 (11)'] });
    expect(evaluateFilters(formatted, 'message.received', msg({ from: '111@c.us' }))).toBe(true);
  });

  it('resolves sender to author in group messages', () => {
    const f = filters({ field: 'sender', operator: 'is', value: ['part@c.us'] });
    const groupMsg = msg({ from: '120@g.us', author: 'part@c.us', isGroup: true });
    expect(evaluateFilters(f, 'message.received', groupMsg)).toBe(true);
  });

  it('supports isNot (negation), including unknown sender', () => {
    const f = filters({ field: 'sender', operator: 'isNot', value: ['111@c.us'] });
    expect(evaluateFilters(f, 'message.received', msg())).toBe(false);
    expect(evaluateFilters(f, 'message.received', msg({ from: '222@c.us' }))).toBe(true);
    expect(evaluateFilters(f, 'message.received', msg({ from: undefined }))).toBe(true);
  });

  it('ANDs all conditions', () => {
    const f = filters(
      { field: 'sender', operator: 'is', value: ['111@c.us'] },
      { field: 'type', operator: 'is', value: ['image'] },
    );
    expect(evaluateFilters(f, 'message.received', msg({ type: 'image' }))).toBe(true);
    expect(evaluateFilters(f, 'message.received', msg({ type: 'text' }))).toBe(false);
  });

  it('body contains is case-insensitive by default and case-sensitive when set', () => {
    expect(
      evaluateFilters(filters({ field: 'body', operator: 'contains', value: 'hello' }), 'message.received', msg()),
    ).toBe(true);
    expect(
      evaluateFilters(
        filters({ field: 'body', operator: 'contains', value: 'hello', caseSensitive: true }),
        'message.received',
        msg(),
      ),
    ).toBe(false);
  });

  it('body equals is exact and case-insensitive by default', () => {
    expect(
      evaluateFilters(filters({ field: 'body', operator: 'equals', value: 'Hello World' }), 'message.received', msg()),
    ).toBe(true);
    expect(
      evaluateFilters(filters({ field: 'body', operator: 'equals', value: 'hello world' }), 'message.received', msg()),
    ).toBe(true);
    expect(
      evaluateFilters(filters({ field: 'body', operator: 'equals', value: 'Hello' }), 'message.received', msg()),
    ).toBe(false);
  });

  it('boolean fields (isGroup, fromMe, hasMedia)', () => {
    expect(
      evaluateFilters(
        filters({ field: 'isGroup', operator: 'is', value: true }),
        'message.received',
        msg({ isGroup: true }),
      ),
    ).toBe(true);
    expect(evaluateFilters(filters({ field: 'fromMe', operator: 'is', value: false }), 'message.received', msg())).toBe(
      true,
    );
    expect(
      evaluateFilters(filters({ field: 'hasMedia', operator: 'is', value: true }), 'message.received', msg()),
    ).toBe(false);
    expect(
      evaluateFilters(
        filters({ field: 'hasMedia', operator: 'is', value: true }),
        'message.received',
        msg({ media: { mimetype: 'image/png' } }),
      ),
    ).toBe(true);
  });

  it('applies message-family smart filters to the normalized message.edited payload', () => {
    const edit = msg({
      from: '120@g.us',
      author: 'part@c.us',
      body: 'Updated invoice',
      type: 'image',
      isGroup: true,
      hasMedia: true,
      mentionedIds: ['boss@c.us'],
    });
    const f = filters(
      { field: 'sender', operator: 'is', value: ['part@c.us'] },
      { field: 'body', operator: 'contains', value: 'invoice' },
      { field: 'type', operator: 'is', value: ['image'] },
      { field: 'hasMedia', operator: 'is', value: true },
      { field: 'mentions', operator: 'is', value: ['boss@c.us'] },
    );

    expect(evaluateFilters(f, 'message.edited', edit)).toBe(true);
    expect(evaluateFilters(f, 'message.edited', { ...edit, hasMedia: false })).toBe(false);
  });

  it('mentions (idArray) intersects', () => {
    const f = filters({ field: 'mentions', operator: 'is', value: ['boss@c.us'] });
    expect(evaluateFilters(f, 'message.received', msg({ mentionedIds: ['boss@c.us', 'x@c.us'] }))).toBe(true);
    expect(evaluateFilters(f, 'message.received', msg({ mentionedIds: ['x@c.us'] }))).toBe(false);
  });

  it('skips conditions whose field is not registered for the event family', () => {
    // A message-family field carried on a (future) session event is ignored, not failed.
    const f = filters({ field: 'sender', operator: 'is', value: ['nobody@c.us'] });
    expect(evaluateFilters(f, 'session.status', msg())).toBe(true);
  });

  // ── WaId-aware id matching (engine-neutral) ───────────────────────
  // Ids are compared by their neutral WaId key, so a contact matches regardless of the dialect the
  // engine emits and regardless of how the filter is written (bare digits or a JID).

  describe('engine-neutral id matching', () => {
    it('matches the same user across @c.us and @s.whatsapp.net', () => {
      const f = filters({ field: 'sender', operator: 'is', value: ['111@c.us'] });
      expect(evaluateFilters(f, 'message.received', msg({ from: '111@s.whatsapp.net' }))).toBe(true);
    });

    it('matches a JID filter against a bare-number actor and vice versa', () => {
      expect(
        evaluateFilters(
          filters({ field: 'sender', operator: 'is', value: ['111'] }),
          'message.received',
          msg({ from: '111@c.us' }),
        ),
      ).toBe(true);
    });

    it('ignores a :device suffix', () => {
      const f = filters({ field: 'sender', operator: 'is', value: ['111@c.us'] });
      expect(evaluateFilters(f, 'message.received', msg({ from: '111:12@s.whatsapp.net' }))).toBe(true);
    });

    it('resolves a lid actor to its phone via the resolver (the lid->phone table)', () => {
      // Group author arrives as an unresolved @lid; the resolver maps it to the phone the filter names.
      const resolve = (jid: string): string | null => (jid.startsWith('111@lid') ? '628999' : null);
      const f = filters({ field: 'sender', operator: 'is', value: ['628999'] });
      const data = msg({ from: '120@g.us', author: '111@lid', isGroup: true });
      expect(evaluateFilters(f, 'message.received', data, resolve)).toBe(true);
    });

    it('control: without a resolver the same lid actor does NOT match the phone filter', () => {
      const f = filters({ field: 'sender', operator: 'is', value: ['628999'] });
      const data = msg({ from: '120@g.us', author: '111@lid', isGroup: true });
      expect(evaluateFilters(f, 'message.received', data)).toBe(false);
    });

    it('resolves lid actors inside mentions (idArray) too', () => {
      const resolve = (jid: string): string | null => (jid.startsWith('111@lid') ? '628999' : null);
      const f = filters({ field: 'mentions', operator: 'is', value: ['628999'] });
      expect(evaluateFilters(f, 'message.received', msg({ mentionedIds: ['111@lid', 'x@c.us'] }), resolve)).toBe(true);
    });
  });
});
