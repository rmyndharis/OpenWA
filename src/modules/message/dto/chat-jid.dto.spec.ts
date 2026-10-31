import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendMediaMessageDto, SendTextMessageDto } from './send-message.dto';
import { ForwardMessageDto, ReactMessageDto, SendLocationDto } from './message-actions.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

const validateDto = (cls: new () => object, obj: unknown) =>
  validate(plainToInstance(cls, obj, GLOBAL_VALIDATION_OPTIONS.transformOptions), GLOBAL_VALIDATION_OPTIONS);
const failedProperties = async (cls: new () => object, obj: unknown): Promise<string[]> =>
  (await validateDto(cls, obj)).map(e => e.property);

// An id the engine cannot decode (no domain, or whitespace) used to reach it: Baileys threw a TypeError out
// of `jidDecode`, the caller saw a 500, and the send breaker counted it against a healthy session.
describe('a chat id on a send or action body must be localpart@host', () => {
  const refused = ['x', '6281270008896', '628127 0008896@c.us', '@c.us', 'abc@', 628123456789];
  const accepted = ['6281270008896@c.us', '120363000000000001@g.us', '1234@s.whatsapp.net', '1234567890123@lid'];

  it.each(refused)('refuses %j on a text send', async chatId => {
    expect(await failedProperties(SendTextMessageDto, { chatId, text: 'hi' })).toEqual(['chatId']);
  });

  it.each(accepted)('accepts %j on a text send', async chatId => {
    expect(await failedProperties(SendTextMessageDto, { chatId, text: 'hi' })).toEqual([]);
  });

  it('holds on the media, location, reaction and forward bodies too', async () => {
    expect(await failedProperties(SendMediaMessageDto, { chatId: 'x', url: 'https://example.com/a.png' })).toEqual([
      'chatId',
    ]);
    expect(await failedProperties(SendLocationDto, { chatId: 'x', latitude: 1, longitude: 2 })).toEqual(['chatId']);
    expect(await failedProperties(ReactMessageDto, { chatId: 'x', messageId: 'm', emoji: '👍' })).toEqual(['chatId']);
    const forward = { fromChatId: 'a@c.us', toChatId: 'b@c.us', messageId: 'm' };
    expect(await failedProperties(ForwardMessageDto, forward)).toEqual([]);
    expect(await failedProperties(ForwardMessageDto, { ...forward, fromChatId: 'x' })).toEqual(['fromChatId']);
    expect(await failedProperties(ForwardMessageDto, { ...forward, toChatId: 'x' })).toEqual(['toChatId']);
  });
});

// A request body that names a chat is checked with the shared pattern wherever it is declared, so a DTO
// added later cannot reintroduce the 500 by leaving the pattern out.
describe('every request DTO that names a chat holds the JID pattern', () => {
  const root = join(__dirname, '..', '..');
  const dtoFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return dtoFiles(path);
      return name.endsWith('.dto.ts') ? [path] : [];
    });

  it('finds the declarations and none lacks the pattern', () => {
    const declaration = /^\s+(chatId|toChatId|fromChatId)!:\s*string;/;
    const missing: string[] = [];
    let seen = 0;
    for (const file of dtoFiles(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!declaration.test(line)) return;
        const decorators = lines.slice(Math.max(0, index - 10), index).join('\n');
        if (!decorators.includes('@IsString()')) return; // a response field, nothing validates it
        seen += 1;
        // Four older DTOs spell the same regular expression out instead of importing the constant.
        if (!decorators.includes('CHAT_JID_PATTERN') && !decorators.includes('[^\\s@]+@[^\\s@]+')) {
          missing.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(seen).toBeGreaterThanOrEqual(27);
    expect(missing).toEqual([]);
  });
});
