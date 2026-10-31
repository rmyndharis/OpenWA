import { z } from 'zod';
import { CHAT_ID_MAX_LENGTH, CHAT_JID_MESSAGE, CHAT_JID_PATTERN } from '../../modules/message/dto/send-message.dto';

/**
 * A chat id taken by a tool, bounded as the REST bodies bound it: the id is stored under a btree index,
 * and PostgreSQL answers a value past about 2.7 KB with a 500 that the MCP client reads as an internal
 * tool error.
 */
export const chatIdSchema = z.string().min(1).max(CHAT_ID_MAX_LENGTH);

/**
 * A chat id for a tool whose REST body also checks the form of the id (localpart@host, no whitespace),
 * so a malformed id is refused here as it is there instead of failing in the engine.
 */
export const chatJidSchema = chatIdSchema.regex(CHAT_JID_PATTERN, CHAT_JID_MESSAGE);
