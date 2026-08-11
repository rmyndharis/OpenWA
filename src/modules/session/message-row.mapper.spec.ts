import { buildMessageMetadata, storableWaMessageId, MEDIA_MESSAGE_TYPES } from './message-row.mapper';
import type { IncomingMessage, MessageType } from '../../engine/interfaces/whatsapp-engine.interface';

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({ type: 'chat', ...over }) as IncomingMessage;

describe('buildMessageMetadata', () => {
  it('returns undefined when there is nothing to store (the column is nullable)', () => {
    expect(buildMessageMetadata(msg())).toBeUndefined();
  });

  it('stores the engine-supplied media as-is', () => {
    const media = { mimetype: 'image/png', data: 'x' };

    expect(buildMessageMetadata(msg({ type: 'image', media }))).toEqual({ media });
  });

  it('stores a quoted message', () => {
    const quotedMessage = { id: 'q1' };

    expect(buildMessageMetadata(msg({ quotedMessage } as Partial<IncomingMessage>))).toEqual({ quotedMessage });
  });

  it('stores call metadata', () => {
    const call = { video: false, missed: false };

    expect(buildMessageMetadata(msg({ call }))).toEqual({ call });
  });

  it('stores every present field together', () => {
    const built = buildMessageMetadata(
      msg({
        type: 'image',
        media: { mimetype: 'image/png' },
        quotedMessage: { id: 'q' },
        call: { video: false, missed: false },
      } as Partial<IncomingMessage>),
    );

    expect(Object.keys(built!).sort()).toEqual(['call', 'media', 'quotedMessage']);
  });

  describe('omitted-media synthesis', () => {
    // A wwjs own-send echo whose media download failed and the history backfill both arrive without
    // the payload; without a marker the row renders as an empty bubble and drops out of the by-type
    // stats.
    it.each([...MEDIA_MESSAGE_TYPES])('synthesizes a placeholder for a media-typed %s when asked', type => {
      expect(buildMessageMetadata(msg({ type: type as MessageType }), true)).toEqual({
        media: { mimetype: '', omitted: true },
      });
    });

    it('does NOT synthesize for the live inbound path, where absent media means no media', () => {
      // This is the one deliberate difference between the three persist paths.
      expect(buildMessageMetadata(msg({ type: 'image' }))).toBeUndefined();
    });

    it('does not synthesize for a non-media type', () => {
      expect(buildMessageMetadata(msg({ type: 'chat' as MessageType }), true)).toBeUndefined();
    });

    it('prefers real media over the placeholder', () => {
      const media = { mimetype: 'image/png' };

      expect(buildMessageMetadata(msg({ type: 'image', media }), true)).toEqual({ media });
    });

    it('returns a fresh placeholder each time, so callers cannot mutate a shared object', () => {
      const a = buildMessageMetadata(msg({ type: 'image' }), true)!;
      const b = buildMessageMetadata(msg({ type: 'image' }), true)!;

      expect(a.media).not.toBe(b.media);
    });
  });
});

describe('storableWaMessageId', () => {
  it('passes a real id through', () => {
    expect(storableWaMessageId('wa-1')).toBe('wa-1');
  });

  it('maps the empty sentinel to undefined so the row stores NULL', () => {
    // `''` would collide the second unreadable-id message on the (sessionId, waMessageId) unique
    // index and lose the row; NULL is what that index exempts.
    expect(storableWaMessageId('')).toBeUndefined();
  });

  it('maps undefined to undefined', () => {
    expect(storableWaMessageId(undefined)).toBeUndefined();
  });
});
