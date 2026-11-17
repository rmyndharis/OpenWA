import { messageTools } from './message.tools';
import {
  DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES,
  createInlineMediaSpender,
  type MessageService,
} from '../../../modules/message/message.service';
import type { Message } from '../../../modules/message/entities/message.entity';

const MIB = 1024 * 1024;
const BUDGET = DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;

const row = (encodedBytes: number): Message =>
  ({
    type: 'image',
    metadata: { media: { mimetype: 'image/jpeg', data: 'A'.repeat(encodedBytes) } },
  }) as unknown as Message;
const media = (message: Message): { data?: string; omitted?: boolean; sizeBytes?: number } =>
  (message.metadata as { media: { data?: string; omitted?: boolean; sizeBytes?: number } }).media;
const kept = (message: Message): boolean => media(message).omitted === undefined && media(message).data !== undefined;

/**
 * The bound the MCP MessageList tool states for inline media is what the list read applies. A client sizes its
 * context from that sentence, and one payload is let through whatever its size, so a result can pass the stated
 * budget by up to one stored payload (about 68 MiB of base64 at the default download cap).
 */
describe('the inline media bound of the MessageList tool', () => {
  const description = (): string => {
    const tool = messageTools({} as MessageService).find(candidate => candidate.name === 'MessageList');
    if (!tool) throw new Error('MessageList is not registered');
    return tool.description;
  };

  it('states the budget the service applies by default', () => {
    const stated = /\((\d+) MiB by default/.exec(description());
    expect(stated).not.toBeNull();
    expect(Number(stated![1]) * MIB).toBe(BUDGET);
  });

  it('says the newest payload is let through whatever its size', () => {
    expect(description()).toContain('newest payload');
    expect(description()).toContain('whatever its size');
  });

  it('keeps payloads while they fit the budget and omits the first one that does not', () => {
    const spend = createInlineMediaSpender(BUDGET);
    const [first, second, third] = [row(3 * MIB), row(3 * MIB), row(3 * MIB)];
    [first, second, third].forEach(spend);
    expect([kept(first), kept(second), kept(third)]).toEqual([true, true, false]);
    expect(media(third).sizeBytes).toBe(Math.floor((3 * MIB * 3) / 4));
  });

  it('lets the newest payload through when it alone is over the budget, and omits the next one', () => {
    const spend = createInlineMediaSpender(BUDGET);
    const [newest, older] = [row(BUDGET + MIB), row(1024)];
    spend(newest);
    spend(older);
    expect(media(newest).data).toHaveLength(BUDGET + MIB);
    expect(kept(older)).toBe(false);
    expect(media(older).sizeBytes).toBe(768);
  });

  it('grants no allowance at a budget of zero, newest payload included', () => {
    const spend = createInlineMediaSpender(0);
    const newest = row(1024);
    spend(newest);
    expect(kept(newest)).toBe(false);
    expect(media(newest).sizeBytes).toBe(768);
  });
});
