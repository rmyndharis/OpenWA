import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CHAT_SCOPED_KEY } from '../../modules/auth/decorators/auth.decorators';
import { MessageController } from '../../modules/message/message.controller';

/**
 * docs/06 names the routes a chat-restricted key may call. Every read of one chat's messages that carries the chat
 * fence (a GET route that names `:chatId`) has to be named there, or a reader concludes it answers 403 for an allowed
 * chat. The handlers are enumerated from the controller, so a fenced read added later fails here until it is named.
 * The name is looked for in the clause that lists the routes, not in the whole paragraph: the paragraph says "history
 * sync" too, which would stand in for the history route.
 */
describe('docs/06 list of chat-scoped message reads', () => {
  const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', '06-api-specification.md'), 'utf8');
  const paragraph = doc.split('\n').find(line => line.startsWith('A key may also be restricted to selected chats'));
  /** The clause that lists the chat-scoped routes: from its first words to the next semicolon. */
  const clauseOf = (text: string | undefined): string | undefined =>
    /The chat-scoped routes are[^;]*/.exec(text ?? '')?.[0];
  const clause = clauseOf(paragraph);
  const names = (text: string | undefined, word: string): boolean =>
    new RegExp(`\\b${word}\\b`).test(clauseOf(text) ?? '');

  const fencedChatReads = Object.getOwnPropertyNames(MessageController.prototype)
    .map(name => ({
      name,
      handler: (MessageController.prototype as unknown as Record<string, object>)[name],
    }))
    .filter(({ handler }) => typeof handler === 'function')
    .filter(({ handler }) => Reflect.getMetadata(CHAT_SCOPED_KEY, handler) === 'fenced')
    .filter(({ handler }) => Reflect.getMetadata('method', handler) === RequestMethod.GET)
    .map(({ name, handler }) => ({ name, path: Reflect.getMetadata('path', handler) as string }))
    .filter(({ path }) => path.startsWith(':chatId/'));

  it('finds the paragraph that lists the chat-scoped routes', () => {
    expect(paragraph).toBeDefined();
  });

  it('finds the fenced reads of one chat (vacuity guard)', () => {
    // history, reactions, receipts and media at the time of writing.
    expect(fencedChatReads.map(read => read.name)).toEqual(
      expect.arrayContaining(['getChatHistory', 'getReactions', 'getReceipts', 'getChatMedia']),
    );
  });

  it('finds the clause that lists the chat-scoped routes', () => {
    expect(clause).toContain('the message sends');
    expect(clause).toContain('of one chat');
  });

  it.each(fencedChatReads.map(read => [read.name, read.path] as const))(
    'names the route of %s (%s), which carries the chat fence',
    (_name, path) => {
      expect(names(paragraph, path.split('/').pop() as string)).toBe(true);
    },
  );

  // A word that the rest of the paragraph repeats must not stand in for the clause: taking it out of the clause fails.
  it.each(['history', 'reactions', 'receipts', 'media'])('fails when the clause no longer names %s', word => {
    const dropped = (clause as string).replace(new RegExp(`\\b${word}\\b`), '');
    const without = (paragraph as string).replace(clause as string, () => dropped);

    expect(names(paragraph, word)).toBe(true);
    expect(names(without, word)).toBe(false);
  });
});
