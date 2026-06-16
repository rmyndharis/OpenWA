import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MarkChatReadDto } from './mark-chat-read.dto';

const errorCount = (chatId: unknown): number => validateSync(plainToInstance(MarkChatReadDto, { chatId })).length;

describe('MarkChatReadDto chatId validation', () => {
  // Engine-neutral: accept any active engine's JID scheme — whatsapp-web.js (@c.us/@g.us/@lid)
  // AND a swapped engine like Baileys (@s.whatsapp.net). The adapter validates/normalises further.
  it.each(['1234567890@c.us', '1234567890-123@g.us', '1234567890@lid', '1234567890@s.whatsapp.net'])(
    'accepts a valid JID across engines: %s',
    chatId => {
      expect(errorCount(chatId)).toBe(0);
    },
  );

  it.each(['', 'not-a-jid', 'no-at-host', '1234567890@', '@host.example', 'has space@c.us'])(
    'rejects a malformed chatId: %s',
    chatId => {
      expect(errorCount(chatId)).toBeGreaterThan(0);
    },
  );
});
