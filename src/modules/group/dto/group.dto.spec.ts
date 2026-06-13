import 'reflect-metadata';
import { validate, ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ParticipantsDto, CreateGroupDto, GroupSubjectDto } from './group.dto';

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
});
