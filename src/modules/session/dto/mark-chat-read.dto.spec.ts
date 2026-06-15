import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MarkChatReadDto } from './mark-chat-read.dto';

const errorCount = (chatId: unknown): number => validateSync(plainToInstance(MarkChatReadDto, { chatId })).length;

describe('MarkChatReadDto chatId validation', () => {
  it.each(['1234567890@c.us', '1234567890-123@g.us', '1234567890@lid'])('accepts a valid JID: %s', chatId => {
    expect(errorCount(chatId)).toBe(0);
  });

  it.each(['', 'not-a-jid', 'abc@c.us', '1234567890@s.whatsapp.net', '1234567890@lid.us'])(
    'rejects an invalid chatId: %s',
    chatId => {
      expect(errorCount(chatId)).toBeGreaterThan(0);
    },
  );
});
