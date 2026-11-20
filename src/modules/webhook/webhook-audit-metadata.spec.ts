import { readFileSync } from 'fs';
import { join } from 'path';
import { WebhookController } from './webhook.controller';
import { Webhook } from './entities/webhook.entity';

/**
 * An operator reads the metadata of a webhook audit row in docs/05 to learn what the row holds, for example where a
 * webhook was re-pointed from. This ties that sentence to the keys the controller writes.
 */
describe('the metadata of a webhook audit row, as docs/05 describes it', () => {
  /** Each key a row carries, and the words the paragraph names it with. */
  const DOCUMENTED_AS: Record<string, string> = {
    webhookId: 'webhook id',
    urlHost: 'URL host',
    events: 'events',
    active: '`active` flag',
    changed: 'names of the changed fields',
    previousUrlHost: 'previous URL host',
  };

  const webhook = (overrides: Partial<Webhook>): Webhook =>
    ({
      id: 'wh-1',
      sessionId: 's-1',
      url: 'https://one.example/hook',
      events: ['message.received'],
      secret: null,
      headers: null,
      filters: null,
      active: true,
      retryCount: 3,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    }) as Webhook;

  it('names every key that a create, a change of URL and a delete write', async () => {
    const before = webhook({});
    const after = webhook({ url: 'https://two.example/hook', active: false });
    const service = {
      create: jest.fn().mockResolvedValue(before),
      findOne: jest.fn().mockResolvedValue(before),
      update: jest.fn().mockResolvedValue(after),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const logInfo = jest.fn();
    const controller = new WebhookController(service as never, { logInfo } as never);

    await controller.create('s-1', {} as never);
    await controller.update('s-1', 'wh-1', {});
    await controller.delete('s-1', 'wh-1');

    const rows = logInfo.mock.calls as Array<[string, { metadata: Record<string, unknown> }]>;
    const carried = new Set(rows.flatMap(([, context]) => Object.keys(context.metadata)));
    expect([...carried].sort()).toEqual(Object.keys(DOCUMENTED_AS).sort());

    const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', '05-database-design.md'), 'utf8');
    const text = doc.replace(/\s+/g, ' ');
    const start = text.indexOf('webhook changes (`webhook_created`');
    const sentence = text.slice(start, text.indexOf('webhook deliveries', start));
    expect(start).toBeGreaterThan(-1);
    for (const words of Object.values(DOCUMENTED_AS)) expect(sentence).toContain(words);
  });
});
