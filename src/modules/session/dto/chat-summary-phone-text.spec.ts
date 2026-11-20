import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Only the Baileys store fills ChatSummary.phone in; whatsapp-web.js lists none. Each place that describes the field
 * has to say so, or a reader expects a number on both engines. A statement is read from the start of the ChatSummary
 * declaration to the end of the phone field; the text of name says "a Baileys chat", so only the phone text can hold
 * "Baileys only".
 */
const repoRoot = join(__dirname, '..', '..', '..', '..');

const STATEMENTS: [file: string, from: string, to: RegExp][] = [
  ['src/modules/session/dto/chat-summary.dto.ts', 'export class ChatSummaryDto', /phone\?: string;/],
  ['src/engine/interfaces/whatsapp-engine.interface.ts', 'export interface ChatSummary {', /phone\?: string;/],
  ['sdk/javascript/src/types.ts', 'export interface ChatSummary {', /phone\?: string;/],
  ['sdk/go/types_chat.go', 'type ChatSummary struct', /Phone\s+string/],
  [
    'sdk/java/src/main/java/com/rmyndharis/openwa/model/ChatSummary.java',
    'public record ChatSummary(',
    /String phone\)/,
  ],
  ['sdk/python/openwa/types.py', 'class ChatSummary(TypedDict):', /phone: NotRequired\[str\]/],
  ['sdk/php/src/Resources/ChatsResource.php', 'Entries include lastMessageType', /public function list\(/],
];

describe('ChatSummary.phone', () => {
  it.each(STATEMENTS)('is described as Baileys only in %s', (path, from, to) => {
    const text = readFileSync(join(repoRoot, path), 'utf8');
    const start = text.indexOf(from);
    expect(start).toBeGreaterThanOrEqual(0);
    const tail = text.slice(start);
    const end = tail.search(to);
    expect(end).toBeGreaterThan(0);
    expect(tail.slice(0, end)).toContain('Baileys only');
  });
});
