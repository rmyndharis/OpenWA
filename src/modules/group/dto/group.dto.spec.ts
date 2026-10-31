import 'reflect-metadata';
import { validate, ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  ParticipantsDto,
  CreateGroupDto,
  GroupSubjectDto,
  GroupDescriptionDto,
  GroupMemberLabelDto,
  JoinGroupDto,
  GroupSettingsDto,
  MembershipRequestActionDto,
  SetGroupPictureDto,
  GROUP_PARTICIPANTS_MAX,
} from './group.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

// Built from the options the global ValidationPipe uses (src/config/app-validation.ts), including the
// enableImplicitConversion transform option: without it a spec exercises a stricter pipe than the one
// that actually runs, so a payload this file rejects can still be accepted in production.
const { transformOptions: PIPE_TRANSFORM_OPTS, ...PIPE_OPTS } = GLOBAL_VALIDATION_OPTIONS;

function errorsFor<T extends object>(cls: new () => T, payload: unknown): Promise<ValidationError[]> {
  return validate(plainToInstance(cls, payload as object, PIPE_TRANSFORM_OPTS), PIPE_OPTS);
}

function instanceFor<T extends object>(cls: new () => T, payload: unknown): T {
  return plainToInstance(cls, payload as object, PIPE_TRANSFORM_OPTS);
}

describe('group DTO validation', () => {
  it('SetGroupPictureDto accepts only an absolute http(s) url, the only form the engines fetch', async () => {
    for (const url of ['example.com/a.jpg', 'ftp://example.com/a.jpg']) {
      expect((await errorsFor(SetGroupPictureDto, { url })).length).toBeGreaterThan(0);
    }
    for (const url of ['https://example.com/a.jpg', 'HTTPS://example.com/a.jpg', 'http://example.com/a.jpg']) {
      expect(await errorsFor(SetGroupPictureDto, { url })).toHaveLength(0);
    }
    expect(await errorsFor(SetGroupPictureDto, { url: 'example.com/a.jpg', base64: 'QUJD' })).toHaveLength(0);
    // A base64 that is only a data-URI prefix strips to nothing, so the url is what would be sent.
    const prefixOnly = { url: 'cdn/group.jpg', base64: 'data:image/jpeg;base64,', mimetype: 'image/jpeg' };
    expect((await errorsFor(SetGroupPictureDto, prefixOnly)).length).toBeGreaterThan(0);
    // base64 wins when both are set, so a url alongside it must not switch off its type check.
    const arrayBase64 = { url: 'https://a.example/x.jpg', base64: ['QUJD'], mimetype: 'image/jpeg' };
    expect((await errorsFor(SetGroupPictureDto, arrayBase64)).some(e => e.property === 'base64')).toBe(true);
  });

  it('accepts a valid participants body (regression for #190)', async () => {
    const errors = await errorsFor(ParticipantsDto, { participants: ['628123456789@c.us'] });
    expect(errors).toHaveLength(0);
  });

  it('rejects an empty participants array', async () => {
    const errors = await errorsFor(ParticipantsDto, { participants: [] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-array participants value', async () => {
    const errors = await errorsFor(ParticipantsDto, { participants: 'not-an-array' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a participants array at the batch cap (256)', async () => {
    const participants = Array.from({ length: 256 }, (_, i) => `628100000${String(i).padStart(3, '0')}@c.us`);
    expect(await errorsFor(ParticipantsDto, { participants })).toHaveLength(0);
    expect(await errorsFor(CreateGroupDto, { name: 'G', participants })).toHaveLength(0);
  });

  it('rejects a participants array beyond the batch cap (the engine works the list sequentially)', async () => {
    const participants = Array.from({ length: 257 }, (_, i) => `628100000${String(i).padStart(3, '0')}@c.us`);
    const batchErrors = await errorsFor(ParticipantsDto, { participants });
    expect(batchErrors.some(e => e.property === 'participants')).toBe(true);
    const createErrors = await errorsFor(CreateGroupDto, { name: 'G', participants });
    expect(createErrors.some(e => e.property === 'participants')).toBe(true);
  });

  it('still rejects unknown properties (forbidNonWhitelisted intact)', async () => {
    const errors = await errorsFor(ParticipantsDto, { participants: ['x@c.us'], hacker: true });
    expect(errors.some(e => e.property === 'hacker')).toBe(true);
  });

  it('requires both name and participants on CreateGroupDto', async () => {
    const errors = await errorsFor(CreateGroupDto, {});
    expect(errors.map(e => e.property)).toEqual(expect.arrayContaining(['name', 'participants']));
  });

  it('requires a non-empty subject on GroupSubjectDto', async () => {
    const errors = await errorsFor(GroupSubjectDto, { subject: '' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('caps the group description length (accepts 1024, rejects beyond)', async () => {
    expect(await errorsFor(GroupDescriptionDto, { description: 'a'.repeat(1024) })).toHaveLength(0);
    expect((await errorsFor(GroupDescriptionDto, { description: 'a'.repeat(1025) })).length).toBeGreaterThan(0);
  });

  it('bounds the member label at 30 characters, and an empty one clears it', async () => {
    expect(await errorsFor(GroupMemberLabelDto, { label: '' })).toHaveLength(0);
    expect(await errorsFor(GroupMemberLabelDto, { label: 'a'.repeat(30) })).toHaveLength(0);
    expect((await errorsFor(GroupMemberLabelDto, { label: 'a'.repeat(31) })).map(e => e.property)).toEqual(['label']);
  });

  // Baileys sends label.slice(0, 30), which counts UTF-16 code units. @MaxLength would take both of these,
  // and Baileys would then drop the tail behind a 200, the second one through the middle of an emoji.
  it('counts the member label in UTF-16 code units, the unit Baileys cuts it at', async () => {
    expect(await errorsFor(GroupMemberLabelDto, { label: '😀'.repeat(15) })).toHaveLength(0);
    expect((await errorsFor(GroupMemberLabelDto, { label: '😀'.repeat(16) })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupMemberLabelDto, { label: 'a' + '😀'.repeat(15) })).length).toBeGreaterThan(0);
  });

  // A number is read as its decimal string, as on every @ToStrictString field.
  it.each([
    ['missing', {}],
    ['a boolean', { label: true }],
    ['an object', { label: { text: 'Site A' } }],
    ['null', { label: null }],
    ['an array', { label: ['Site A'] }],
  ])('refuses a member label that is %s', async (_name, payload) => {
    expect((await errorsFor(GroupMemberLabelDto, payload)).map(e => e.property)).toEqual(['label']);
  });

  it('publishes the member label cap in the contract', () => {
    const published = Reflect.getMetadata('swagger/apiModelProperties', GroupMemberLabelDto.prototype, 'label') as {
      maxLength?: number;
    };
    expect(published.maxLength).toBe(30);
  });

  it('requires a non-empty invite code on JoinGroupDto', async () => {
    expect(await errorsFor(JoinGroupDto, { inviteCode: 'AbCdEfGhIjKl' })).toHaveLength(0);
    expect((await errorsFor(JoinGroupDto, { inviteCode: '' })).length).toBeGreaterThan(0);
    expect((await errorsFor(JoinGroupDto, {})).length).toBeGreaterThan(0);
  });

  it('caps the invite code at 128 characters, as the contract publishes', async () => {
    const published = Reflect.getMetadata('swagger/apiModelProperties', JoinGroupDto.prototype, 'inviteCode') as {
      maxLength?: number;
    };
    expect(published.maxLength).toBe(128);
    expect(await errorsFor(JoinGroupDto, { inviteCode: 'a'.repeat(128) })).toHaveLength(0);
    const tooLong = await errorsFor(JoinGroupDto, { inviteCode: 'a'.repeat(129) });
    expect(tooLong.map(e => e.property)).toEqual(['inviteCode']);
  });

  it('SetGroupPictureDto accepts only an image mimetype, so a non-image payload is refused with 400', async () => {
    for (const mimetype of ['image/jpeg', 'image/png']) {
      expect(await errorsFor(SetGroupPictureDto, { base64: 'QUJD', mimetype })).toHaveLength(0);
    }
    for (const mimetype of ['application/pdf', 'text/plain', 'jpeg']) {
      const errors = await errorsFor(SetGroupPictureDto, { base64: 'QUJD', mimetype });
      expect(errors.map(e => e.property)).toEqual(['mimetype']);
    }
  });

  it('GroupSettingsDto accepts an empty body and any subset of fields (at-least-one is a service rule)', async () => {
    expect(await errorsFor(GroupSettingsDto, {})).toHaveLength(0);
    expect(await errorsFor(GroupSettingsDto, { announce: true })).toHaveLength(0);
    expect(await errorsFor(GroupSettingsDto, { announce: false, locked: true, ephemeralSeconds: 0 })).toHaveLength(0);
    expect(await errorsFor(GroupSettingsDto, { memberAddMode: 'admins' })).toHaveLength(0);
    expect(await errorsFor(GroupSettingsDto, { memberAddMode: 'all' })).toHaveLength(0);
  });

  it('GroupSettingsDto rejects wrong field types and a negative timer', async () => {
    expect((await errorsFor(GroupSettingsDto, { announce: 'yes' })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { locked: 1 })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { ephemeralSeconds: -1 })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { ephemeralSeconds: 1.5 })).length).toBeGreaterThan(0);
    for (const memberAddMode of ['everyone', '', 1]) {
      expect((await errorsFor(GroupSettingsDto, { memberAddMode })).length).toBeGreaterThan(0);
    }
  });

  it('GroupSettingsDto rejects an explicit null (400) instead of applying it as a value', async () => {
    expect((await errorsFor(GroupSettingsDto, { announce: null })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { locked: null })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { ephemeralSeconds: null })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { memberAddMode: null })).length).toBeGreaterThan(0);
  });

  it('GroupSettingsDto still rejects unknown properties (forbidNonWhitelisted intact)', async () => {
    const errors = await errorsFor(GroupSettingsDto, { announce: true, hacker: true });
    expect(errors.some(e => e.property === 'hacker')).toBe(true);
  });

  // A form-encoded body reaches the DTO as string scalars, and the pipe converts implicitly. These
  // assert the resulting VALUE, not just the error count: the failure mode being pinned is
  // `announce=false` arriving as `announce: true` and silently restricting the group.
  it('GroupSettingsDto reads a form-encoded "false" as false, not true', () => {
    expect(instanceFor(GroupSettingsDto, { announce: 'false' }).announce).toBe(false);
    expect(instanceFor(GroupSettingsDto, { locked: 'false' }).locked).toBe(false);
    expect(instanceFor(GroupSettingsDto, { announce: 'true' }).announce).toBe(true);
    expect(instanceFor(GroupSettingsDto, { locked: 'true' }).locked).toBe(true);
  });

  it('GroupSettingsDto rejects ambiguous boolean spellings rather than defaulting them to true', async () => {
    for (const value of ['yes', 'no', '0', '1', 'FALSE']) {
      expect((await errorsFor(GroupSettingsDto, { announce: value })).length).toBeGreaterThan(0);
      expect((await errorsFor(GroupSettingsDto, { locked: value })).length).toBeGreaterThan(0);
    }
  });

  // Same class of hole as the booleans above: Number('') and Number('  ') are both 0, and 0 is a
  // meaningful value here (it turns disappearing messages OFF), so an empty form field must not be
  // read as a deliberate request to disable the timer.
  it('GroupSettingsDto rejects an empty ephemeralSeconds instead of reading it as 0', async () => {
    for (const value of ['', '   ']) {
      expect((await errorsFor(GroupSettingsDto, { ephemeralSeconds: value })).length).toBeGreaterThan(0);
    }
  });

  it('GroupSettingsDto still accepts a numeric-string ephemeralSeconds from a form body', () => {
    expect(instanceFor(GroupSettingsDto, { ephemeralSeconds: '86400' }).ephemeralSeconds).toBe(86400);
    expect(instanceFor(GroupSettingsDto, { ephemeralSeconds: '0' }).ephemeralSeconds).toBe(0);
  });
});

/**
 * The approve/reject body draws a sharp line between "omitted" (act on EVERY pending request) and
 * every other shape. An explicit `null` and an empty array must fail validation rather than be
 * read as approve-all — the explicit-null discipline of SetGroupPictureDto — because both are the
 * classic malformed-client shapes, and misreading either mass-approves join requests.
 */
describe('MembershipRequestActionDto', () => {
  it('accepts an empty body — approve/reject ALL pending', async () => {
    expect(await errorsFor(MembershipRequestActionDto, {})).toHaveLength(0);
  });

  it('accepts a named requester list', async () => {
    expect(await errorsFor(MembershipRequestActionDto, { participants: ['628123456789@c.us'] })).toHaveLength(0);
  });

  it('rejects an explicit null — malformed, not approve-all', async () => {
    expect((await errorsFor(MembershipRequestActionDto, { participants: null })).length).toBeGreaterThan(0);
  });

  it('rejects an empty array — naming nobody is not the same claim as "all"', async () => {
    expect((await errorsFor(MembershipRequestActionDto, { participants: [] })).length).toBeGreaterThan(0);
  });

  it('rejects a list beyond the shared participant cap', async () => {
    const oversized = Array.from({ length: GROUP_PARTICIPANTS_MAX + 1 }, (_, i) => `62${i}@c.us`);
    expect((await errorsFor(MembershipRequestActionDto, { participants: oversized })).length).toBeGreaterThan(0);
  });
});
