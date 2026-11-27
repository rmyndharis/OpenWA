import type { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import type { Message } from './entities/message.entity';

const logger = createLogger('MessageEngineChat');

/**
 * The chat to hand the engine for an action on the message `messageId` that its caller names by `chatId`: the chat an
 * API send was delivered to (the contact's LID), when the caller names the chat the send's row is filed under in any
 * form its thread takes it in (`thread`), else the caller's own. The engine checks the message is in the chat it is
 * handed, and the row of such a send is filed under the chat its caller addressed. A row a hook moved is never routed,
 * nor one of another chat, and a read that fails routes nothing.
 */
export async function engineChatOf(
  messages: Repository<Message>,
  sessionId: string,
  chatId: string,
  messageId: string,
  thread: (chatId: string) => Promise<string[]>,
): Promise<string> {
  try {
    const row = await messages.findOne({
      where: { sessionId, waMessageId: messageId },
      select: { chatId: true, engineRef: true },
    });
    if (!row?.engineRef?.addressed) return chatId;
    return row.chatId === chatId || (await thread(chatId)).includes(row.chatId) ? row.engineRef.chatId : chatId;
  } catch (error) {
    logger.warn(`Failed to read the chat message ${messageId} was delivered to`, { error: String(error) });
    return chatId;
  }
}
