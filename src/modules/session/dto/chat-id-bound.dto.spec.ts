import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';
import { SendProductDto } from '../../catalog/dto/send-product.dto';
import { ArchiveChatDto } from './archive-chat.dto';
import { DeleteChatDto } from './delete-chat.dto';
import { MarkChatReadDto } from './mark-chat-read.dto';
import { MarkChatUnreadDto } from './mark-chat-unread.dto';
import { MuteChatDto } from './mute-chat.dto';
import { PinChatDto } from './pin-chat.dto';
import { SubscribePresenceDto } from './presence.dto';
import { SendChatStateDto } from './send-chat-state.dto';

// The send routes store a chat id in an indexed column, and PostgreSQL refuses an index entry past about
// 2.7 KB, which used to surface as a 500 where SQLite stored the value. They bound it at 255, and so does
// every other request body that names a chat, so one limit holds across the API: a product send stores
// the id like the send routes, and a chat action hands it to the engine.
describe('chatId is bounded at 255 characters on the chat action bodies', () => {
  const exact = `${'1'.repeat(250)}@c.us`;
  const over = `${'1'.repeat(251)}@c.us`;

  it.each([
    ['ArchiveChatDto', ArchiveChatDto, { archive: true }],
    ['DeleteChatDto', DeleteChatDto, {}],
    ['MarkChatReadDto', MarkChatReadDto, {}],
    ['MarkChatUnreadDto', MarkChatUnreadDto, {}],
    ['MuteChatDto', MuteChatDto, {}],
    ['PinChatDto', PinChatDto, { pin: true }],
    ['SubscribePresenceDto', SubscribePresenceDto, {}],
    ['SendChatStateDto', SendChatStateDto, { state: 'typing' }],
    ['SendProductDto', SendProductDto, { productId: 'p1' }],
  ] as const)('%s', async (_name, Dto, rest) => {
    const constraintsOf = async (chatId: string): Promise<string[]> => {
      const errors = await validate(plainToInstance(Dto as new () => object, { ...rest, chatId }));
      return errors.filter(e => e.property === 'chatId').flatMap(e => Object.keys(e.constraints ?? {}));
    };
    expect(await constraintsOf(over)).toContain('maxLength');
    expect(await constraintsOf(exact)).not.toContain('maxLength');
  });
});

// docs/06 states one structural rule for the chat id of a chat action: localpart@host with no whitespace.
// It is engine-neutral on purpose (@c.us, @s.whatsapp.net, @g.us and @lid all pass), so it only turns away
// ids that cannot name a chat on any engine. Dropping it from one body lets that garbage reach the engine.
describe('chatId must be localpart@host on the chat action bodies', () => {
  const accepted = ['628123456789@c.us', '628123456789@s.whatsapp.net', '120363000000000000@g.us', '1234567890@lid'];
  const rejected = [
    ['no host separator', '628123456789'],
    ['no local part', '@c.us'],
    ['no host', '628123456789@'],
    ['two separators', '628123456789@@c.us'],
    ['whitespace in the local part', '6281 23@c.us'],
    ['whitespace in the host', '628123456789@c .us'],
    ['leading whitespace', ' 628123456789@c.us'],
    ['trailing newline', '628123456789@c.us\n'],
  ];

  it.each([
    ['ArchiveChatDto', ArchiveChatDto, { archive: true }],
    ['DeleteChatDto', DeleteChatDto, {}],
    ['MarkChatReadDto', MarkChatReadDto, {}],
    ['MarkChatUnreadDto', MarkChatUnreadDto, {}],
    ['MuteChatDto', MuteChatDto, { muteUntil: 1_800_000_000_000 }],
    ['PinChatDto', PinChatDto, { pin: true }],
    ['SubscribePresenceDto', SubscribePresenceDto, {}],
  ] as const)('%s', async (_name, Dto, rest) => {
    const constraintsOf = async (chatId: string): Promise<string[]> => {
      const errors = await validate(
        plainToInstance(Dto as new () => object, { ...rest, chatId }, GLOBAL_VALIDATION_OPTIONS.transformOptions),
        GLOBAL_VALIDATION_OPTIONS,
      );
      return errors.filter(e => e.property === 'chatId').flatMap(e => Object.keys(e.constraints ?? {}));
    };
    for (const chatId of accepted)
      expect({ chatId, failing: await constraintsOf(chatId) }).toEqual({ chatId, failing: [] });
    for (const [why, chatId] of rejected)
      expect({ why, chatId, failing: await constraintsOf(chatId) }).toEqual({ why, chatId, failing: ['matches'] });
  });
});
