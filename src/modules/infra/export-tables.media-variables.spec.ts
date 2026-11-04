import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { InfraDataService } from './infra-data.service';
import { EXPORT_TABLES } from './export-tables';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message } from '../message/entities/message.entity';
import { MessageBatch, BatchStatus } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import * as templateRender from '../../common/utils/template-render';
import { renderTemplate } from '../../common/utils/template-render';

const entities = [
  Session,
  Webhook,
  Message,
  MessageBatch,
  Template,
  BaileysStoredMessage,
  LidMapping,
  ChatState,
  PluginInstance,
  ConversationMapping,
  IngressEvent,
  WebhookDeliveryFailure,
  WebhookOutboxEvent,
  IntegrationDeliveryFailure,
  StatusUpdate,
  AutomationRule,
  SendIdempotencyKey,
];

async function seedSession(ds: DataSource): Promise<string> {
  const id = randomUUID();
  await ds.getRepository(Session).save(
    ds.getRepository(Session).create({
      id,
      name: `session-${id}`,
      status: SessionStatus.DISCONNECTED,
      config: {},
      phone: null,
      pushName: null,
      proxyUrl: null,
      proxyType: null,
      connectedAt: null,
      lastActiveAt: null,
    }),
  );
  return id;
}

const batchExport = EXPORT_TABLES.find(entry => entry.key === 'messageBatches')!;
const strip = batchExport.inlineMedia!.strip;

function entry(base64 = '{{photo}}', variables: Record<string, string> = { photo: 'QUJD' }) {
  return {
    chatId: '628111@c.us',
    type: 'image',
    content: { image: { base64, mimetype: 'image/jpeg', caption: '{{label}}' } },
    variables: { ...variables, label: 'description only' },
  };
}

interface MediaItem {
  content: Record<string, Record<string, string>>;
  variables: Record<string, string>;
}

function stripped(items: unknown[], bytes: number, status = BatchStatus.PROCESSING) {
  let remaining = bytes;
  const admitted: number[] = [];
  const omitted: number[] = [];
  const original = JSON.stringify(items);
  const row = { messages: original, status };
  strip(row as never, encoded => {
    if (encoded > remaining) {
      omitted.push(encoded);
      return true;
    }
    remaining -= encoded;
    admitted.push(encoded);
    return false;
  });
  expect(JSON.stringify(items)).toBe(original);
  return { items: JSON.parse(row.messages) as MediaItem[], row, remaining, admitted, omitted };
}

describe('bulk export budgets payload variables', () => {
  it('uses the actual registered callback', () => {
    expect(typeof strip).toBe('function');
    expect(batchExport.table).toBe('message_batches');
  });
  it.each([0, 3, 4])('keeps literal media exactly when it fits budget %i', bytes => {
    const result = stripped([entry('QUJD', {})], bytes);
    expect(result.items[0].content.image.base64).toBe(bytes >= 4 ? 'QUJD' : undefined);
    expect(result.items[0].variables.label).toBe('description only');
  });
  it('omits the referenced payload variable at a zero budget', () => {
    const result = stripped([entry()], 0).items[0];
    expect(result.content.image.base64).toBeUndefined();
    expect(result.variables.photo).toBeUndefined();
    expect(result.variables.label).toBe('description only');
    expect(result.content.image).toEqual({ mimetype: 'image/jpeg', caption: '{{label}}' });
  });
  it.each(['{{photo}}', '{photo}', '{{ photo }}'])('keeps a payload at its exact encoded size: %s', token => {
    const result = stripped([entry(token)], 4).items[0];
    expect(result.content.image.base64).toBe(token);
    expect(renderTemplate(result.content.image.base64, result.variables)).toBe('QUJD');
  });
  it.each(['{{image.data}}', '{{ image-data }}'])('uses the renderer grammar for key %s', token => {
    const name = token.includes('.') ? 'image.data' : 'image-data';
    const result = stripped([entry(token, { [name]: 'QUJD' })], 0).items[0];
    expect(result.content.image.base64).toBeUndefined();
    expect(result.variables[name]).toBeUndefined();
    expect(result.variables.label).toBe('description only');
  });
  it('omits an over-budget value even when its placeholder is smaller', () => {
    const result = stripped([entry('{{p}}', { p: 'QUJDREVGSElKS0w=' })], 8).items[0];
    expect(result.content.image.base64).toBeUndefined();
    expect(result.variables.p).toBeUndefined();
  });
  it('reads a template once however many variables the item carries', () => {
    const variables = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`v${i}`, 'x']));
    const render = jest.spyOn(templateRender, 'renderTemplate');
    try {
      const result = stripped([entry('{{v7}}{{v1999}}', variables)], 2);
      expect(render.mock.calls.length).toBeLessThanOrEqual(1);
      expect(result.admitted).toEqual([2]);
      expect(result.items[0].content.image.base64).toBe('{{v7}}{{v1999}}');
      expect(Object.keys(result.items[0].variables)).toHaveLength(2001);
    } finally {
      render.mockRestore();
    }
  });
  it('preserves unrelated descriptive variables without charging them', () => {
    const result = stripped([entry('{{p}}', { p: 'QUJD', unused: 'a descriptive value longer than the budget' })], 4);
    expect(result.items[0].content.image.base64).toBe('{{p}}');
    expect(result.items[0].variables.unused).toBe('a descriptive value longer than the budget');
    expect(result.items[0].variables.label).toBe('description only');
  });
  it('keeps multiple referenced values at their total stored payload size', () => {
    const result = stripped([entry('{{first}}{{second}}', { first: 'QUJD', second: 'REVG' })], 8).items[0];
    expect(renderTemplate(result.content.image.base64, result.variables)).toBe('QUJDREVG');
    expect(result.content.image.base64).toBe('{{first}}{{second}}');
  });
  it('omits every referenced payload value when their total does not fit', () => {
    const result = stripped([entry('{{first}}{{second}}', { first: 'QUJD', second: 'REVG' })], 7).items[0];
    expect(result.content.image.base64).toBeUndefined();
    expect(result.variables).toEqual({ label: 'description only' });
  });
  it('charges one stored variable once when two media fields share it', () => {
    const message = entry();
    (message.content as Record<string, unknown>).document = { base64: '{{photo}}', filename: 'tiny.jpg' };
    const result = stripped([message], 4).items[0];
    expect(result.content.image.base64).toBe('{{photo}}');
    expect(result.content.document.base64).toBe('{{photo}}');
    expect(result.variables.photo).toBe('QUJD');
  });
  it('does not leave shared references behind when their variable is omitted', () => {
    const message = entry();
    (message.content as Record<string, unknown>).document = { base64: '{{photo}}', filename: 'tiny.jpg' };
    const result = stripped([message], 0).items[0];
    expect(result.content.image.base64).toBeUndefined();
    expect(result.content.document.base64).toBeUndefined();
    expect(result.variables.photo).toBeUndefined();
    expect(result.content.document.filename).toBe('tiny.jpg');
  });
  it('charges copies in separate message objects separately', () => {
    const result = stripped([entry(), entry()], 4).items;
    expect(result[0].variables.photo).toBe('QUJD');
    expect(result[0].content.image.base64).toBe('{{photo}}');
    expect(result[1].content.image.base64).toBeUndefined();
    expect(result[1].variables.photo).toBeUndefined();
  });
  it('shares the budget between literal and templated media', () => {
    const result = stripped([entry('QUJD', {}), entry()], 8).items;
    expect(result[0].content.image.base64).toBe('QUJD');
    expect(result[1].content.image.base64).toBe('{{photo}}');
    expect(result[1].variables.photo).toBe('QUJD');
  });
  it('keeps an accepted shared variable when a later field does not fit', () => {
    const message = entry('{{photo}}', { photo: 'QUJD', extra: 'REVGSElK' });
    (message.content as Record<string, unknown>).document = { base64: '{{photo}}{{extra}}' };
    const result = stripped([message], 4).items[0];
    expect(result.content.image.base64).toBe('{{photo}}');
    expect(result.content.document.base64).toBeUndefined();
    expect(result.variables).toEqual({ photo: 'QUJD', label: 'description only' });
  });
  it('preserves a shared variable accepted after an earlier field did not fit', () => {
    const message = entry('{{photo}}{{extra}}', { photo: 'QUJD', extra: 'REVGSElK' });
    (message.content as Record<string, unknown>).document = { base64: '{{photo}}' };
    const result = stripped([message], 4).items[0];
    expect(result.content.image.base64).toBeUndefined();
    expect(result.content.document.base64).toBe('{{photo}}');
    expect(result.variables).toEqual({ photo: 'QUJD', label: 'description only' });
  });
  it('charges a repeated variable once in its serialized item', () => {
    const result = stripped([entry('{{photo}}{{photo}}')], 4).items[0];
    expect(result.content.image.base64).toBe('{{photo}}{{photo}}');
    expect(result.variables.photo).toBe('QUJD');
  });
  it('charges literal payload segments alongside referenced variables', () => {
    const kept = stripped([entry('QUJD{{photo}}')], 8).items[0];
    expect(kept.content.image.base64).toBe('QUJD{{photo}}');
    expect(kept.variables.photo).toBe('QUJD');
    const omitted = stripped([entry('QUJD{{photo}}')], 7).items[0];
    expect(omitted.content.image.base64).toBeUndefined();
    expect(omitted.variables.photo).toBeUndefined();
  });
  it.each(Object.values(BatchStatus))('enforces the same export budget for a %s batch', status => {
    const result = stripped([entry()], 0, status);
    expect(result.row.status).toBe(status);
    expect(result.items[0].variables.photo).toBeUndefined();
    expect(result.items[0].content.image.base64).toBeUndefined();
  });
  it.each(['not-json', '{}', 'null'])('does not rewrite malformed historical content %s', raw => {
    const row = { messages: raw };
    const spend = jest.fn(() => true);
    strip(row as never, spend);
    expect(row.messages).toBe(raw);
    expect(spend).not.toHaveBeenCalled();
  });
  it('tolerates partial historical list entries and preserves URL references', () => {
    const items = [
      null,
      {},
      { content: null },
      { content: { image: { url: 'https://example.invalid/image' } } },
      entry(),
    ];
    const result = stripped(items, 0).items;
    expect(result.slice(0, 4)).toEqual(items.slice(0, 4));
    expect(result[4].variables.photo).toBeUndefined();
  });
});
describe('real SQLite export reads templated batch payloads', () => {
  let ds: DataSource;
  let service: InfraDataService;
  let sessionId: string;
  const previousBudget = process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES;
  beforeEach(async () => {
    delete process.env.DATABASE_TYPE;
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities,
      synchronize: true,
    }).initialize();
    service = new InfraDataService(
      { get: (key: string, fallback?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : fallback) } as never,
      ds,
    );
    sessionId = await seedSession(ds);
  });
  afterEach(async () => {
    await ds?.destroy();
    if (previousBudget === undefined) delete process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES;
    else process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES = previousBudget;
  });
  async function seedBatch(index: number, status = BatchStatus.PROCESSING): Promise<string> {
    const id = randomUUID();
    await ds.getRepository(MessageBatch).save(
      ds.getRepository(MessageBatch).create({
        id,
        batchId: `batch-${id}`,
        sessionId,
        status,
        messages: [entry()],
        currentIndex: 0,
        startedAt: null,
        completedAt: null,
        createdAt: new Date(1577836800000 + index * 1000),
      }),
    );
    return id;
  }
  it('exports omitted payloads without changing stored or caller-owned values', async () => {
    process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES = '0';
    const id = await seedBatch(1);
    const before = await ds.getRepository(MessageBatch).findOneByOrFail({ id });
    const original = JSON.stringify(before.messages);
    const dump = await service.exportData();
    const messages = JSON.parse(dump.tables.messageBatches[0].messages as string) as MediaItem[];
    expect(messages[0].variables.photo).toBeUndefined();
    expect(messages[0].content.image.base64).toBeUndefined();
    expect(messages[0].variables.label).toBe('description only');
    expect(dump.omittedInlineMedia.messageBatches).toBeGreaterThan(0);
    expect(JSON.stringify(before.messages)).toBe(original);
    expect(JSON.stringify((await ds.getRepository(MessageBatch).findOneByOrFail({ id })).messages)).toBe(original);
  });
  it('spends one budget newest-first across the 200-row read boundary and keeps key order', async () => {
    process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES = '4';
    let newest = '';
    for (let index = 0; index < 201; index++) newest = await seedBatch(index);
    let keyOrder: string[] = [];
    const query = ds.query.bind(ds);
    const spy = jest.spyOn(ds, 'query').mockImplementation((async (...args: Parameters<typeof query>) => {
      const sql = args[0];
      const rows: unknown = await query(...args);
      if (sql.startsWith('SELECT id, "created_at"') && sql.endsWith('FROM message_batches')) {
        keyOrder = (rows as Array<{ id: string }>).map(row => row.id);
      }
      return rows;
    }) as typeof ds.query);
    try {
      const dump = await service.exportData();
      const rows = dump.tables.messageBatches;
      expect(keyOrder).toHaveLength(201);
      expect(rows.map(row => row.id)).toEqual(keyOrder);
      const retained = rows.filter(
        row => (JSON.parse(row.messages as string) as MediaItem[])[0].variables.photo !== undefined,
      );
      expect(retained.map(row => row.id)).toEqual([newest]);
      expect(
        rows.filter(row => (JSON.parse(row.messages as string) as MediaItem[])[0].content.image.base64 !== undefined),
      ).toHaveLength(1);
      expect(dump.omittedInlineMedia.messageBatches).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
  it('excludes rows inserted after the key read and drops rows deleted before their chunk', async () => {
    process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES = '100';
    const kept = await seedBatch(1);
    const deleted = await seedBatch(2);
    let added = '';
    const query = ds.query.bind(ds);
    const spy = jest.spyOn(ds, 'query').mockImplementation((async (...args: Parameters<typeof query>) => {
      const sql = args[0];
      const rows: unknown = await query(...args);
      if (sql.startsWith('SELECT id, "created_at"')) {
        await ds.getRepository(MessageBatch).delete({ id: deleted });
        added = await seedBatch(3);
      }
      return rows;
    }) as typeof ds.query);
    try {
      const dump = await service.exportData();
      expect(dump.tables.messageBatches.map(row => row.id)).toEqual([kept]);
      expect(added).not.toBe('');
      expect(await ds.getRepository(MessageBatch).findOneBy({ id: added })).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
