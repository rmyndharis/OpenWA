import { NotFoundException } from '@nestjs/common';
import type { Client } from 'whatsapp-web.js';
import { WwebjsLabels } from './wwebjs-labels';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { LabelNotFoundError } from '../../common/errors/label-not-found.error';

/**
 * Three label reads had no error handling on the page call at all, so a dead page was both an opaque
 * 500 and a death the session was never told about; the label write saw only the `[LT01] Only
 * Whatsapp business` case and passed everything else through raw. getChatsByLabel in the same file
 * already made the split, which is why one label read answered 503 and the neighbouring ones 500.
 */
const logger = createLogger('wwebjs-label-transport-death.spec');

describe('label operations distinguish a dead page from an ordinary failure', () => {
  const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');

  function makeLabels(op: string, reject: unknown): { labels: WwebjsLabels; reportIfPageTransportError: jest.Mock } {
    const rejects = (name: string) =>
      op === name ? jest.fn().mockRejectedValue(reject) : jest.fn().mockResolvedValue([]);
    const chat = { getLabels: rejects('getChatLabels') };
    const client = {
      // getLabelById reads the full list: Client.getLabelById throws page-side for an unknown id.
      getLabels:
        op === 'getLabels' || op === 'getLabelById'
          ? jest.fn().mockRejectedValue(reject)
          : jest.fn().mockResolvedValue([]),
      getChatById: jest.fn().mockResolvedValue(chat),
      addOrRemoveLabels:
        op === 'changeChatLabel' ? jest.fn().mockRejectedValue(reject) : jest.fn().mockResolvedValue(undefined),
    };
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: (error: unknown) => error === transportError,
      reportIfPageTransportError,
      logger,
    } as unknown as WwebjsEngineHost;
    return { labels: new WwebjsLabels(host), reportIfPageTransportError };
  }

  // changeChatLabel is private; addLabelToChat is its public entry point.
  const call = (labels: WwebjsLabels, op: string): Promise<unknown> =>
    ({
      getLabels: () => labels.getLabels(),
      getLabelById: () => labels.getLabelById('7'),
      getChatLabels: () => labels.getChatLabels('628123@c.us'),
      changeChatLabel: () => labels.addLabelToChat('628123@c.us', '7'),
    })[op]!();

  const OPS = ['getLabels', 'getLabelById', 'getChatLabels', 'changeChatLabel'];

  it.each(OPS)('%s answers a dead page with the 503 its route documents', async op => {
    const { labels, reportIfPageTransportError } = makeLabels(op, transportError);

    await expect(call(labels, op)).rejects.toThrow(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
  });

  // Negative twin: an ordinary page-side failure must still surface untouched, so the fix cannot
  // simply relabel every failure as a retryable 503.
  it.each(OPS)('%s still propagates an ordinary failure unchanged', async op => {
    const refusal = new Error('Evaluation failed: label not found');
    const { labels, reportIfPageTransportError } = makeLabels(op, refusal);

    await expect(call(labels, op)).rejects.toBe(refusal);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  // The label write's one bespoke mapping must survive the guard: a personal account still gets the
  // "not a Business account" refusal rather than a transport failure.
  it('still maps the page-side LT01 refusal to the unsupported error', async () => {
    const { labels } = makeLabels('changeChatLabel', new Error('[LT01] Only Whatsapp business'));

    await expect(labels.addLabelToChat('628123@c.us', '7')).rejects.toThrow(/business/i);
  });

  // Client.getLabelById never resolves null for an unknown id (its page code serializes undefined),
  // so the adapter picks from the list; a missing id, or any id on a personal account, is null (404).
  it('getLabelById resolves a listed label and null for an unknown one', async () => {
    const client = { getLabels: jest.fn().mockResolvedValue([{ id: '5', name: 'Paid', hexColor: '#25D366' }]) };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger,
    } as unknown as WwebjsEngineHost;
    const labels = new WwebjsLabels(host);

    await expect(labels.getLabelById('5')).resolves.toEqual({ id: '5', name: 'Paid', hexColor: '#25D366' });
    await expect(labels.getLabelById('999')).resolves.toBeNull();
    client.getLabels.mockResolvedValue([]);
    await expect(labels.getLabelById('5')).resolves.toBeNull();
  });

  // Client.getChatById resolves undefined for a chat the page cannot resolve; dereferencing it was a
  // TypeError, a 500 on GET and on both chat-label writes that read the current set first. The read
  // answers an empty set, but a write must not: upstream resolves it as a silent no-op.
  it('reads an unresolved chat as unlabelled and refuses to write to it', async () => {
    const client = {
      getChatById: jest.fn().mockResolvedValue(undefined),
      addOrRemoveLabels: jest.fn().mockResolvedValue(undefined),
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger,
    } as unknown as WwebjsEngineHost;
    const labels = new WwebjsLabels(host);

    await expect(labels.getChatLabels('628999@c.us')).resolves.toEqual([]);
    await expect(labels.addLabelToChat('628999@c.us', '7')).rejects.toBeInstanceOf(NotFoundException);
    await expect(labels.removeLabelFromChat('628999@c.us', '7')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.addOrRemoveLabels).not.toHaveBeenCalled();
  });
});

/**
 * getChatsByLabelId resolves each chat through getChatById, so one group whose metadata refresh fails
 * one of WhatsApp Web's own invariants (#1950) rejected the whole list, which answered as an unknown
 * label. The fallback runs the real in-page reads against a stand-in page.
 */
describe('getChatsByLabel with a group whose metadata refresh fails', () => {
  const g = globalThis as unknown as { window?: unknown };
  const invariant = Object.assign(new Error('Minified invariant #76137; %s'), { name: 'Invariant Violation' });

  afterEach(() => {
    delete g.window;
    jest.restoreAllMocks();
  });

  const pageChat = (id: string, title: string, group: boolean) => ({
    id,
    serialize: () => ({ id: { _serialized: id }, formattedTitle: title, unreadCount: 1, msgs: [] }),
    mute: { expiration: 0 },
    formattedTitle: title,
    groupMetadata: group ? { serialize: () => ({ participants: [] }) } : undefined,
  });

  function makeLabels(labelItems: { parentType: string; parentId: string }[] | undefined) {
    const chats: Record<string, ReturnType<typeof pageChat>> = {
      '628111@c.us': pageChat('628111@c.us', 'Alice', false),
      '120363@g.us': pageChat('120363@g.us', 'Coex group', true),
    };
    g.window = {
      require: (m: string) =>
        m === 'WAWebLidMigrationUtils'
          ? { toPn: () => null }
          : {
              Chat: { get: (id: string) => chats[id] },
              Label: {
                get: () => labelItems && { labelItemCollection: { getModelsArray: () => labelItems } },
              },
            },
      WWebJS: {
        getChatModel: (chat: ReturnType<typeof pageChat>) =>
          chat.groupMetadata ? Promise.reject(invariant) : Promise.resolve({ ...chat.serialize(), isGroup: false }),
      },
    };
    const client = {
      getChatsByLabelId: jest.fn().mockRejectedValue(new Error('Evaluation failed: Invariant Violation: #76137')),
      pupPage: { evaluate: jest.fn((fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg))) },
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger,
    } as unknown as WwebjsEngineHost;
    return new WwebjsLabels(host);
  }

  it('lists every chat on the label, the failing group from its loaded metadata', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const labels = makeLabels([
      { parentType: 'Chat', parentId: '628111@c.us' },
      { parentType: 'Message', parentId: 'msg-1' },
      { parentType: 'Chat', parentId: '120363@g.us' },
    ]);

    await expect(labels.getChatsByLabel('7')).resolves.toEqual([
      expect.objectContaining({ id: '628111@c.us', name: 'Alice', isGroup: false, unreadCount: 1 }),
      expect.objectContaining({ id: '120363@g.us', name: 'Coex group', isGroup: true }),
    ]);
  });

  it('still answers an unknown label as not found', async () => {
    await expect(makeLabels(undefined).getChatsByLabel('7')).rejects.toBeInstanceOf(LabelNotFoundError);
  });
});
