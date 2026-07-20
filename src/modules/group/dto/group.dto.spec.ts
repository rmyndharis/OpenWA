import 'reflect-metadata';
import { validate, ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  ParticipantsDto,
  CreateGroupDto,
  GroupSubjectDto,
  GroupDescriptionDto,
  JoinGroupDto,
  GroupSettingsDto,
} from './group.dto';

// Mirror the global ValidationPipe options (src/main.ts): whitelist + forbidNonWhitelisted.
const PIPE_OPTS = { whitelist: true, forbidNonWhitelisted: true };

function errorsFor<T extends object>(cls: new () => T, payload: unknown): Promise<ValidationError[]> {
  return validate(plainToInstance(cls, payload as object), PIPE_OPTS);
}

describe('group DTO validation', () => {
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

  it('requires a non-empty invite code on JoinGroupDto', async () => {
    expect(await errorsFor(JoinGroupDto, { inviteCode: 'AbCdEfGhIjKl' })).toHaveLength(0);
    expect((await errorsFor(JoinGroupDto, { inviteCode: '' })).length).toBeGreaterThan(0);
    expect((await errorsFor(JoinGroupDto, {})).length).toBeGreaterThan(0);
  });

  it('GroupSettingsDto accepts an empty body and any subset of fields (at-least-one is a service rule)', async () => {
    expect(await errorsFor(GroupSettingsDto, {})).toHaveLength(0);
    expect(await errorsFor(GroupSettingsDto, { announce: true })).toHaveLength(0);
    expect(await errorsFor(GroupSettingsDto, { announce: false, locked: true, ephemeralSeconds: 0 })).toHaveLength(0);
  });

  it('GroupSettingsDto rejects wrong field types and a negative timer', async () => {
    expect((await errorsFor(GroupSettingsDto, { announce: 'yes' })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { locked: 1 })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { ephemeralSeconds: -1 })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { ephemeralSeconds: 1.5 })).length).toBeGreaterThan(0);
  });

  it('GroupSettingsDto rejects an explicit null (400) instead of applying it as a value', async () => {
    expect((await errorsFor(GroupSettingsDto, { announce: null })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { locked: null })).length).toBeGreaterThan(0);
    expect((await errorsFor(GroupSettingsDto, { ephemeralSeconds: null })).length).toBeGreaterThan(0);
  });

  it('GroupSettingsDto still rejects unknown properties (forbidNonWhitelisted intact)', async () => {
    const errors = await errorsFor(GroupSettingsDto, { announce: true, hacker: true });
    expect(errors.some(e => e.property === 'hacker')).toBe(true);
  });
});
