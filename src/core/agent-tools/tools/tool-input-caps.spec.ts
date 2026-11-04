import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { MessageService } from '../../../modules/message/message.service';
import type { GroupService } from '../../../modules/group/group.service';
import {
  CHAT_ID_MAX_LENGTH,
  MENTIONS_MAX,
  MESSAGE_TEXT_MAX_LENGTH,
  SendTextMessageDto,
} from '../../../modules/message/dto/send-message.dto';
import {
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_NUMBER_MAX_LENGTH,
  LOCATION_TEXT_MAX_LENGTH,
  REACTION_EMOJI_MAX_LENGTH,
  ReactMessageDto,
  ReplyMessageDto,
  SendContactDto,
  SendLocationDto,
} from '../../../modules/message/dto/message-actions.dto';
import {
  CreateGroupDto,
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_NAME_MAX_LENGTH,
  GROUP_PARTICIPANTS_MAX,
  GroupDescriptionDto,
  GroupSubjectDto,
  ParticipantsDto,
} from '../../../modules/group/dto/group.dto';
import { MarkChatReadDto } from '../../../modules/session/dto/mark-chat-read.dto';
import { MarkChatUnreadDto } from '../../../modules/session/dto/mark-chat-unread.dto';
import { SubscribePresenceDto } from '../../../modules/session/dto/presence.dto';
import { SendChatStateDto } from '../../../modules/session/dto/send-chat-state.dto';
import { z } from 'zod';
import type { AnyToolDescriptor } from '../tool-descriptor';
import { allAgentTools } from '.';
import { messageTools } from './message.tools';
import { groupTools } from './group.tools';

// Matches src/config/app-validation.ts (see message-actions.dto.spec.ts) so the DTO side of the
// parity check runs the same validator semantics as the production pipe.
const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };

const messages = messageTools({} as unknown as MessageService);
const groups = groupTools({} as unknown as GroupService);

function tool(name: string): AnyToolDescriptor {
  const found = [...messages, ...groups].find(t => t.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

interface CapCase {
  label: string;
  toolName: string;
  field: string;
  cap: number;
  toolInput: Record<string, unknown>;
  dtoClass: new () => object;
  dtoPayload: Record<string, unknown>;
}

// Every string field whose Zod schema previously had no max while the equivalent REST DTO
// enforces one via class-validator. Both sides now read the same exported constant.
const CASES: CapCase[] = [
  {
    label: 'MessageSendLocation.description ↔ SendLocationDto.description',
    toolName: 'MessageSendLocation',
    field: 'description',
    cap: LOCATION_TEXT_MAX_LENGTH,
    toolInput: { sessionId: 's1', chatId: 'x@c.us', latitude: -6.2, longitude: 106.8 },
    dtoClass: SendLocationDto,
    dtoPayload: { chatId: 'x@c.us', latitude: -6.2, longitude: 106.8 },
  },
  {
    label: 'MessageSendLocation.address ↔ SendLocationDto.address',
    toolName: 'MessageSendLocation',
    field: 'address',
    cap: LOCATION_TEXT_MAX_LENGTH,
    toolInput: { sessionId: 's1', chatId: 'x@c.us', latitude: -6.2, longitude: 106.8 },
    dtoClass: SendLocationDto,
    dtoPayload: { chatId: 'x@c.us', latitude: -6.2, longitude: 106.8 },
  },
  {
    label: 'MessageSendContact.contactName ↔ SendContactDto.contactName',
    toolName: 'MessageSendContact',
    field: 'contactName',
    cap: CONTACT_NAME_MAX_LENGTH,
    toolInput: { sessionId: 's1', chatId: 'x@c.us', contactName: 'Alice', contactNumber: '628123456789' },
    dtoClass: SendContactDto,
    dtoPayload: { chatId: 'x@c.us', contactName: 'Alice', contactNumber: '628123456789' },
  },
  {
    label: 'MessageSendContact.contactNumber ↔ SendContactDto.contactNumber',
    toolName: 'MessageSendContact',
    field: 'contactNumber',
    cap: CONTACT_NUMBER_MAX_LENGTH,
    toolInput: { sessionId: 's1', chatId: 'x@c.us', contactName: 'Alice', contactNumber: '628123456789' },
    dtoClass: SendContactDto,
    dtoPayload: { chatId: 'x@c.us', contactName: 'Alice', contactNumber: '628123456789' },
  },
  {
    label: 'MessageReply.text ↔ ReplyMessageDto.text',
    toolName: 'MessageReply',
    field: 'text',
    cap: MESSAGE_TEXT_MAX_LENGTH,
    toolInput: { sessionId: 's1', chatId: 'x@c.us', quotedMessageId: 'm1', text: 'hi' },
    dtoClass: ReplyMessageDto,
    dtoPayload: { chatId: 'x@c.us', quotedMessageId: 'm1', text: 'hi' },
  },
  {
    label: 'MessageReact.emoji ↔ ReactMessageDto.emoji',
    toolName: 'MessageReact',
    field: 'emoji',
    cap: REACTION_EMOJI_MAX_LENGTH,
    toolInput: { sessionId: 's1', chatId: 'x@c.us', messageId: 'm1', emoji: '👍' },
    dtoClass: ReactMessageDto,
    dtoPayload: { chatId: 'x@c.us', messageId: 'm1', emoji: '👍' },
  },
  {
    label: 'GroupCreate.name ↔ CreateGroupDto.name',
    toolName: 'GroupCreate',
    field: 'name',
    cap: GROUP_NAME_MAX_LENGTH,
    toolInput: { sessionId: 's1', name: 'weekend', participants: ['628123456789@c.us'] },
    dtoClass: CreateGroupDto,
    dtoPayload: { name: 'weekend', participants: ['628123456789@c.us'] },
  },
  {
    label: 'GroupSetSubject.subject ↔ GroupSubjectDto.subject',
    toolName: 'GroupSetSubject',
    field: 'subject',
    cap: GROUP_NAME_MAX_LENGTH,
    toolInput: { sessionId: 's1', groupId: '120363@g.us', subject: 'new subject' },
    dtoClass: GroupSubjectDto,
    dtoPayload: { subject: 'new subject' },
  },
  {
    label: 'GroupSetDescription.description ↔ GroupDescriptionDto.description',
    toolName: 'GroupSetDescription',
    field: 'description',
    cap: GROUP_DESCRIPTION_MAX_LENGTH,
    toolInput: { sessionId: 's1', groupId: '120363@g.us', description: 'rules' },
    dtoClass: GroupDescriptionDto,
    dtoPayload: { description: 'rules' },
  },
];

// Same parity idea as the string caps above, for the participants arrays: the Zod schemas had
// min(1) but no max while the REST DTOs enforce ArrayMaxSize(GROUP_PARTICIPANTS_MAX).
const PARTICIPANT_CASES: CapCase[] = [
  {
    label: 'GroupCreate.participants ↔ CreateGroupDto.participants',
    toolName: 'GroupCreate',
    field: 'participants',
    cap: GROUP_PARTICIPANTS_MAX,
    toolInput: { sessionId: 's1', name: 'weekend' },
    dtoClass: CreateGroupDto,
    dtoPayload: { name: 'weekend' },
  },
  {
    label: 'GroupAddParticipants.participants ↔ ParticipantsDto.participants',
    toolName: 'GroupAddParticipants',
    field: 'participants',
    cap: GROUP_PARTICIPANTS_MAX,
    toolInput: { sessionId: 's1', groupId: '120363@g.us' },
    dtoClass: ParticipantsDto,
    dtoPayload: {},
  },
  {
    // The tool path calls the service directly, so the ValidationPipe never runs and the zod schema
    // is the only cap between an agent and the engine. This case fails if either side moves.
    label: 'MessageSendText.mentions ↔ SendTextMessageDto.mentions',
    toolName: 'MessageSendText',
    field: 'mentions',
    cap: MENTIONS_MAX,
    toolInput: { sessionId: 's1', chatId: '120363@g.us', text: 'hi' },
    dtoClass: SendTextMessageDto,
    dtoPayload: { chatId: '120363@g.us', text: 'hi' },
  },
];

async function dtoFieldErrors(c: CapCase, value: unknown): Promise<boolean> {
  const instance = plainToInstance(c.dtoClass, { ...c.dtoPayload, [c.field]: value }, PIPE_TRANSFORM_OPTS);
  const errors = await validate(instance);
  return errors.some(e => e.property === c.field);
}

describe('agent-tool input caps (parity with the REST DTOs)', () => {
  it.each(CASES)('$label: accepts a value at the cap in both MCP and REST', async c => {
    const atCap = 'x'.repeat(c.cap);
    const parsed = tool(c.toolName).inputSchema.safeParse({ ...c.toolInput, [c.field]: atCap });
    expect(parsed.success).toBe(true);
    expect(await dtoFieldErrors(c, atCap)).toBe(false);
  });

  it.each(CASES)('$label: rejects a value above the cap in both MCP and REST', async c => {
    const overCap = 'x'.repeat(c.cap + 1);
    const parsed = tool(c.toolName).inputSchema.safeParse({ ...c.toolInput, [c.field]: overCap });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.includes(c.field) && i.code === 'too_big')).toBe(true);
    }
    expect(await dtoFieldErrors(c, overCap)).toBe(true);
  });

  it.each(PARTICIPANT_CASES)('$label: accepts a list at the cap in both MCP and REST', async c => {
    const atCap = Array.from({ length: c.cap }, () => '628123456789@c.us');
    const parsed = tool(c.toolName).inputSchema.safeParse({ ...c.toolInput, [c.field]: atCap });
    expect(parsed.success).toBe(true);
    expect(await dtoFieldErrors(c, atCap)).toBe(false);
  });

  it.each(PARTICIPANT_CASES)('$label: rejects a list above the cap in both MCP and REST', async c => {
    const overCap = Array.from({ length: c.cap + 1 }, () => '628123456789@c.us');
    const parsed = tool(c.toolName).inputSchema.safeParse({ ...c.toolInput, [c.field]: overCap });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.includes(c.field) && i.code === 'too_big')).toBe(true);
    }
    expect(await dtoFieldErrors(c, overCap)).toBe(true);
  });
});

/**
 * Every identifier a tool requires must be non-empty, as REST requires it (IsNotEmpty on a body
 * field, or a path segment that cannot be empty). The tool path calls the service directly, so an
 * empty chatId would otherwise persist a row, reach the engine and fail there as a server error.
 * Walks the whole registry so a tool added later is covered without editing this list.
 */
describe('agent-tool identifiers reject an empty string', () => {
  const idFields = allAgentTools({} as never).flatMap(t =>
    Object.entries((t.inputSchema as unknown as z.ZodObject<Record<string, z.ZodType>>).shape)
      .filter(([key, schema]) => /Id$|^number$/.test(key) && !schema.safeParse(undefined).success)
      .map(([key, schema]) => [`${t.name}.${key}`, schema] as const),
  );

  it('finds the identifier fields to check', () => {
    expect(idFields.map(([label]) => label)).toEqual(
      expect.arrayContaining(['MessageSendText.chatId', 'MessageReply.quotedMessageId', 'MessageForward.toChatId']),
    );
  });

  it.each(idFields)('%s rejects an empty string', (_label, schema) => {
    expect(schema.safeParse('').success).toBe(false);
  });
});

/**
 * A chat id is stored under a btree index, which PostgreSQL cannot hold past about 2.7 KB, and the tool
 * path calls the service directly. The REST bodies cap it; so does every tool field that names a chat.
 */
describe('agent-tool chat ids are capped as the REST bodies cap them', () => {
  const chatFields = allAgentTools({} as never).flatMap(t =>
    Object.entries((t.inputSchema as unknown as z.ZodObject<Record<string, z.ZodType>>).shape)
      .filter(([key]) => /^(chatId|fromChatId|toChatId)$/.test(key))
      .map(([key, schema]) => [`${t.name}.${key}`, schema] as const),
  );

  it('finds the chat id fields to check', () => {
    expect(chatFields.map(([label]) => label)).toEqual(
      expect.arrayContaining([
        'MessageSendText.chatId',
        'MessageForward.fromChatId',
        'MessageForward.toChatId',
        'SessionMarkChatRead.chatId',
      ]),
    );
  });

  // A JID of the given length, so the cap is what accepts or rejects it on the fields that also check the shape.
  const jidOfLength = (length: number): string => `${'x'.repeat(length - 2)}@c`;

  it.each(chatFields)('%s accepts an id at the cap and rejects one past it', (_label, schema) => {
    expect(schema.safeParse(jidOfLength(CHAT_ID_MAX_LENGTH)).success).toBe(true);
    expect(schema.safeParse(jidOfLength(CHAT_ID_MAX_LENGTH + 1)).success).toBe(false);
  });
});

/**
 * Three chat routes also require the form localpart@host with no whitespace, and the tools call the
 * service directly, so without the same rule a malformed id reaches the engine as a failed call where
 * REST answers 400. Each tool must accept and reject exactly the ids its REST body does.
 */
describe('MCP tool chat ids take the shape the REST bodies require', () => {
  const tools = allAgentTools({} as never);
  const CASES: Array<[string, new () => object, Record<string, unknown>]> = [
    ['SessionSubscribePresence', SubscribePresenceDto, {}],
    ['SessionMarkChatRead', MarkChatReadDto, {}],
    ['SessionMarkChatUnread', MarkChatUnreadDto, {}],
    ['SessionSendChatState', SendChatStateDto, { state: 'typing' }],
  ];
  const WELL_FORMED = ['628123@c.us', '120363@g.us', '1234@s.whatsapp.net', '9876@lid'];
  const MALFORMED = [
    'abc',
    '@c.us',
    '628123@',
    ' 628123@c.us',
    '628123@c.us ',
    '628123@c.us\n',
    'a b@c.us',
    '@@',
    '628123@c.us@g.us',
  ];

  it.each(CASES)('%s accepts and rejects the same chat ids as its REST body', async (name, dtoClass, extra) => {
    const tool = tools.find(t => t.name === name)!;
    for (const chatId of [...WELL_FORMED, ...MALFORMED]) {
      const toolAccepts = tool.inputSchema.safeParse({ sessionId: 's1', chatId, ...extra }).success;
      const errors = await validate(plainToInstance(dtoClass, { chatId, ...extra }, PIPE_TRANSFORM_OPTS));
      const restAccepts = !errors.some(e => e.property === 'chatId');
      expect({ chatId, toolAccepts }).toEqual({ chatId, toolAccepts: restAccepts });
      expect(restAccepts).toBe(WELL_FORMED.includes(chatId));
    }
  });
});
