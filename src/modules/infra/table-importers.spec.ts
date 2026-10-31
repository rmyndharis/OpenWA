import { TABLE_IMPORTERS } from './table-importers';

/**
 * The sessions importer is the one restore path that writes a value later used to build an on-disk
 * auth-directory path, and it bypasses CreateSessionDto. Both columns matter: the id keys the
 * directory, the name is matched against the legacy one. A row carrying a traversal in either must
 * be skipped with a reason rather than inserted.
 */
describe('sessions table importer', () => {
  const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
  const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: '0a941dac-a965-45e7-b318-74ae8be134f0',
    name: 'my-bot',
    status: 'created',
    ...overrides,
  });

  it('accepts a row whose id and name are both safe path keys', () => {
    expect(sessions?.skip?.(row({}) as never)).toBeNull();
  });

  it('skips a row whose id would traverse out of the auth directory', () => {
    expect(sessions?.skip?.(row({ id: '../../etc' }) as never)).toMatch(/unsafe id/);
  });

  it('skips a row whose name would traverse out of the auth directory', () => {
    expect(sessions?.skip?.(row({ name: '../alice' }) as never)).toMatch(/unsafe name/);
  });
});

describe('sessions table importer: desiredState', () => {
  const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
  const base = { id: '0a941dac-a965-45e7-b318-74ae8be134f0', name: 'my-bot', status: 'disconnected' };
  const mapped = (extra: Record<string, unknown>): unknown[] => sessions!.map({ ...base, ...extra } as never);

  it('writes desiredState so a stopped session stays down after a restore', () => {
    expect(sessions?.sql).toContain('"desiredState"');
    expect(sessions?.sql).toContain('$13');
    expect(mapped({ desiredState: 'stopped' })[12]).toBe('stopped');
    // No delete runs for a restored row, so the record of one that failed part-way is a stop.
    expect(mapped({ desiredState: 'deleting' })[12]).toBe('stopped');
    expect(mapped({ desiredState: 'deleting-stopped' })[12]).toBe('stopped');
  });

  it('restores a row without the field, or with an unknown value, as eligible (NULL)', () => {
    expect(mapped({})[12]).toBeNull();
    expect(mapped({ desiredState: 'bogus' })[12]).toBeNull();
  });
});

/**
 * A restore bypasses CreateWebhookDto. Dispatch reads a filters object without a conditions array as
 * "no filtering", so a malformed one stored verbatim would deliver every subscribed event; a non-list
 * events column silently never fires. Both are vetoed with a reason instead.
 */
describe('webhooks table importer', () => {
  const webhooks = TABLE_IMPORTERS.find(importer => importer.key === 'webhooks');
  const skip = (overrides: Record<string, unknown>) =>
    webhooks?.skip?.({ id: 'wh-1', events: ['message.received'], filters: null, ...overrides } as never);
  const chatFilter = { conditions: [{ field: 'isGroup', operator: 'is', value: true }] };

  it('accepts events and filters in either decoded or JSON-text form', () => {
    expect(skip({})).toBeNull();
    expect(skip({ events: '["message.received","*"]', filters: JSON.stringify(chatFilter) })).toBeNull();
    expect(skip({ filters: chatFilter })).toBeNull();
    expect(skip({ events: undefined, filters: undefined })).toBeNull();
  });

  it.each([['message.received'], ['not json'], [{ 0: 'message.received' }], [[1]], ['[null]']])(
    'skips a row whose events is %j',
    events => {
      expect(skip({ events })).toMatch(/events/);
    },
  );

  it.each([[{}], [{ conditions: 'x' }], ['not json'], ['{}'], [{ conditions: [{ field: 'nope', operator: 'is' }] }]])(
    'skips a row whose filters is %j',
    filters => {
      expect(skip({ filters })).toMatch(/filters/);
    },
  );
});

/**
 * A restore bypasses the automation rule DTOs. A conditions value without a conditions array matches
 * every inbound message, so a malformed one stored verbatim would autoreply to every contact.
 */
describe('automationRules table importer', () => {
  const automationRules = TABLE_IMPORTERS.find(importer => importer.key === 'automationRules');
  const skip = (overrides: Record<string, unknown>) =>
    automationRules?.skip?.({ id: 'rule-1', conditions: null, ...overrides } as never);
  const chatCondition = { conditions: [{ field: 'isGroup', operator: 'is', value: false }] };

  it('accepts no conditions, or conditions in either decoded or JSON-text form', () => {
    expect(skip({})).toBeNull();
    expect(skip({ conditions: undefined })).toBeNull();
    expect(skip({ conditions: chatCondition })).toBeNull();
    expect(skip({ conditions: JSON.stringify(chatCondition) })).toBeNull();
  });

  it.each([
    [{ condition: [] }],
    [{ conditions: 'x' }],
    [{ conditions: [null] }],
    ['not json'],
    [{ conditions: [{ field: 'nope', operator: 'is' }] }],
  ])('skips a row whose conditions is %j', conditions => {
    expect(skip({ conditions })).toMatch(/Skipped automation rule rule-1: invalid conditions/);
  });

  // The column is text on both dialects. A decoded object would reach better-sqlite3 as a named
  // parameter bag and fail the insert, rolling back a restore the guard above had accepted.
  it('writes decoded conditions as JSON text, and keeps text or null as they are', () => {
    const conditions = (value: unknown): unknown =>
      automationRules!.map({ id: 'rule-1', conditions: value } as never)[4];
    expect(conditions(chatCondition)).toBe(JSON.stringify(chatCondition));
    expect(conditions(JSON.stringify(chatCondition))).toBe(JSON.stringify(chatCondition));
    expect(conditions(null)).toBeNull();
    expect(conditions(undefined)).toBeNull();
  });
});

/**
 * A restore of the outbox restores the replay backlog. The payload column is text on both dialects, so
 * a decoded object must be written as JSON text: better-sqlite3 would read it as a named parameter bag
 * and fail the insert, rolling back the whole restore on SQLite while PostgreSQL accepted it.
 */
describe('webhookOutboxEvents table importer', () => {
  const outbox = TABLE_IMPORTERS.find(importer => importer.key === 'webhookOutboxEvents');
  const payload = (value: unknown): unknown => outbox!.map({ id: 'ob-1', payload: value } as never)[6];
  const body = { event: 'message.received', data: { id: 'm1' } };

  it('writes a decoded payload as JSON text, and keeps text or null as they are', () => {
    expect(payload(body)).toBe(JSON.stringify(body));
    expect(payload(JSON.stringify(body))).toBe(JSON.stringify(body));
    expect(payload(null)).toBeNull();
    expect(payload(undefined)).toBeNull();
  });
});

/**
 * A template name loses its NUL characters on restore, and (sessionId, name) is unique. Two names of
 * one session that differ only by NUL would collide on insert and roll the restore back, so the
 * guard refuses the second one up front and names both rows.
 */
describe('templates table importer', () => {
  const templates = TABLE_IMPORTERS.find(importer => importer.key === 'templates');
  const rows = [
    { id: 't1', sessionId: 's1', name: 'promo' },
    { id: 't2', sessionId: 's1', name: 'promo\u0000' },
    { id: 't3', sessionId: 's2', name: 'promo' },
    { id: 't4', sessionId: 's1', name: 'other' },
  ];
  const skip = (row: Record<string, unknown>) => templates?.skip?.(row as never, rows as never);

  it('refuses a name that matches another template of the same session once NUL is dropped', () => {
    expect(skip(rows[1])).toBe(
      'Skipped template t2: name "promo" without NUL characters collides with template t1 of session s1',
    );
  });

  it('accepts the first of the pair, the same name in another session, and a distinct name', () => {
    expect(skip(rows[0])).toBeNull();
    expect(skip(rows[2])).toBeNull();
    expect(skip(rows[3])).toBeNull();
  });
});

/**
 * A restore writes with raw SQL, so the NUL drop the entities apply to their free-text columns never
 * runs. PostgreSQL rejects U+0000 in a bound parameter, and an older SQLite backup may hold one, also
 * in template and rule text written before the DTOs refused it, so the importers drop it from those
 * columns and leave ids and lookup keys as they are. A template name is dropped too: no request can
 * look up a name holding NUL, so keeping it only made the template unreachable by name.
 */
describe('table importers: NUL in free text', () => {
  const nul = 'a\u0000b';
  const mapped = (key: string, row: Record<string, unknown>): unknown[] =>
    TABLE_IMPORTERS.find(importer => importer.key === key)!.map(row as never);

  it.each([
    ['sessions', { id: 's1', name: 'my-bot', pushName: nul }, [4]],
    ['messages', { id: 'm1', chatId: nul, chatName: nul, body: nul, mediaMimetype: nul }, [4, 8, 16]],
    [
      'statusUpdates',
      { id: 'su1', contactJid: nul, contactName: nul, contactPushName: nul, caption: nul, mediaMimetype: nul },
      [3, 4, 7, 9],
    ],
    ['webhookDeliveryFailures', { id: 'wf1', lastError: nul }, [9]],
    ['integrationDeliveryFailures', { id: 'df1', lastError: nul }, [7]],
    ['templates', { id: 't1', name: nul, body: nul, header: nul, footer: nul }, [2, 3, 4, 5]],
    ['automationRules', { id: 'r1', name: nul, replyText: nul }, [2, 5]],
  ])('drops it from the %s text columns', (key, row, columns) => {
    const params = mapped(key, row);
    columns.forEach(index => expect(params[index]).toBe('ab'));
  });

  it('keeps it in a lookup column', () => {
    expect(mapped('messages', { id: 'm1', chatId: nul })[3]).toBe(nul);
    expect(mapped('statusUpdates', { id: 'su1', contactJid: nul })[2]).toBe(nul);
  });
});
