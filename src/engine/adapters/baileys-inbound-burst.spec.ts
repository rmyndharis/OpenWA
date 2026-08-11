import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaileysEvents } from './baileys-events';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { createLogger } from '../../common/services/logger.service';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';

/**
 * A burst of inbound media messages must all keep their media.
 *
 * `handleMessagesUpsert` submits every message in an upsert to the inbound limiter synchronously,
 * so admission is decided before any download finishes. With a queue cap equal to the active slots
 * the ninth message onward was rejected and re-processed with `skipMedia`, losing the file for
 * every message past the eighth — one upsert of 40 lost 32.
 *
 * No spec exercised this path at all, and the one fixture that built a limiter used
 * `new ConcurrencyLimiter(1)`, whose unbounded queue cannot shed at any batch size. The whole suite
 * was green in the presence of the defect, and equally green under a "fix" that removed the
 * concurrency bound instead — so this asserts the bound as well as the outcome.
 */

const CONCURRENCY = 4;
const CONNECTED_AT = 1_700_000_000;

function mediaMessage(index: number): WAMessage {
  return {
    key: { id: `m${index}`, remoteJid: '628111@s.whatsapp.net', fromMe: false },
    messageTimestamp: CONNECTED_AT + 60,
    message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1024 } },
  };
}

/** Drain the microtask queue until every submitted task has settled. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe('BaileysEvents inbound media burst', () => {
  const build = (batch: number) => {
    const downloaded: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const warns: string[] = [];

    const events = new BaileysEvents({
      getSocket: () => ({ updateMediaMessage: jest.fn() }) as unknown as WASocket,
      getSocketOrNull: () => null,
      logger: { ...createLogger('BurstSpec'), warn: (m: string) => warns.push(m) },
      toNeutralJid: (jid: string) => jid,
      normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
      connectedAt: CONNECTED_AT,
      // The production wiring, not a test-only limiter — the point of this spec.
      inboundLimiter: new ConcurrencyLimiter(CONCURRENCY),
      recordKeyLidMappings: () => undefined,
      recordMessage: () => undefined,
      recordMessageEdit: () => undefined,
      putStoredMessage: () => undefined,
      getOnMessage: () => undefined,
      getOnMessageCreate: () => undefined,
      getOnMessageRevoked: () => undefined,
      getOnMessageEdited: () => undefined,
      getOnMessageReaction: () => undefined,
      getOnMessageAck: () => undefined,
      getOnGroupEvent: () => undefined,
      getOnCall: () => undefined,
      getOnPresenceUpdate: () => undefined,
      getOnCallOutcome: () => undefined,
    } as never);

    // Stand in for the download: records that media was fetched, and tracks concurrency while it runs.
    (events as unknown as { processInboundMessage: unknown }).processInboundMessage = async (
      msg: WAMessage,
      opts?: { skipMedia?: boolean },
    ): Promise<void> => {
      if (opts?.skipMedia) return;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      downloaded.push(msg.key?.id ?? '?');
      inFlight--;
    };

    const messages = Array.from({ length: batch }, (_, i) => mediaMessage(i + 1));
    return { events, messages, downloaded, warns, peak: () => maxInFlight };
  };

  it.each([12, 40])('keeps the media of every message in a batch of %i', async batch => {
    const h = build(batch);
    h.events.handleMessagesUpsert({ messages: h.messages, type: 'notify' });
    await settle();

    expect(h.downloaded.length).toBe(batch);
    expect(h.warns).toEqual([]);
  });

  it('never exceeds the configured concurrency while doing so', async () => {
    const h = build(40);
    h.events.handleMessagesUpsert({ messages: h.messages, type: 'notify' });
    await settle();

    // Guard the guard: a peak of 0 would mean nothing ran and the assertion above is vacuous.
    expect(h.peak()).toBeGreaterThan(0);
    // Removing the bound instead of the queue cap also makes the test above pass. This is what
    // separates the two.
    expect(h.peak()).toBeLessThanOrEqual(CONCURRENCY);
  });

  // Two different failures reach the rejection handler and they are not the same event. Reporting a
  // failed download as "limiter saturated" sends an operator to look at concurrency settings for a
  // problem that was never there.
  it.each([
    ['ConcurrencyLimiter closed', 'closed during teardown'],
    ['socket hung up', 'download failed'],
  ])('says which failure happened when a submission rejects with "%s"', async (message, expected) => {
    const h = build(1);
    (h.events as unknown as { processInboundMessage: unknown }).processInboundMessage = (
      _msg: WAMessage,
      opts?: { skipMedia?: boolean },
    ): Promise<void> => (opts?.skipMedia ? Promise.resolve() : Promise.reject(new Error(message)));

    h.events.handleMessagesUpsert({ messages: h.messages, type: 'notify' });
    await settle();

    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain(expected);
  });

  // The tests above build their own limiter, so they cannot see how the adapter builds its one.
  // This is the assertion that actually guards production: re-adding the queue cap is the
  // regression, and it is a second constructor argument.
  it('builds the adapter limiter without a queue cap', () => {
    const source = readFileSync(join(__dirname, 'baileys.adapter.ts'), 'utf8');
    const construction = source.match(/new ConcurrencyLimiter\(([\s\S]*?)\);/);

    // Guard the parser: a renamed limiter would make this vacuous.
    expect(construction).not.toBeNull();

    const args = (construction?.[1] ?? '')
      .split(',')
      .map(arg => arg.replace(/\/\/[^\n]*/g, '').trim())
      .filter(Boolean);
    expect(args).toEqual(['inboundMediaConcurrency()']);
  });
});
