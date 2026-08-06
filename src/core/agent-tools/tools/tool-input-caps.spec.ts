import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { MessageService } from '../../../modules/message/message.service';
import type { GroupService } from '../../../modules/group/group.service';
import { MESSAGE_TEXT_MAX_LENGTH } from '../../../modules/message/dto/send-message.dto';
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
import type { AnyToolDescriptor } from '../tool-descriptor';
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
