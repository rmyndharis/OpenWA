import 'reflect-metadata';
import { DECORATORS } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';
import { MuteChatDto } from './mute-chat.dto';

// A mute expiry that is not a positive integer is an instant in the past, so the mute would expire as it
// is set while the request still answered 200 (see the DTO). `null` is the unmute instruction and skips
// the numeric checks; a missing field is not null and must still be refused.
describe('MuteChatDto muteUntil validation', () => {
  const failing = async (body: object): Promise<string[]> =>
    (
      await validate(
        plainToInstance(
          MuteChatDto,
          { chatId: '1234567890-123@g.us', ...body },
          GLOBAL_VALIDATION_OPTIONS.transformOptions,
        ),
        GLOBAL_VALIDATION_OPTIONS,
      )
    ).map(error => error.property);

  it.each([
    ['the smallest positive integer', 1],
    ['an epoch-millisecond expiry', 1_800_000_000_000],
    ['null, which unmutes', null],
  ])('accepts %s', async (_label, muteUntil) => {
    expect(await failing({ muteUntil })).toEqual([]);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['a numeric string', '1'],
    ['an empty string', ''],
    ['a boolean', true],
  ])('rejects %s', async (_label, muteUntil) => {
    expect(await failing({ muteUntil })).toEqual(['muteUntil']);
  });

  it('rejects a missing muteUntil rather than guessing between unmute and mute forever', async () => {
    expect(await failing({})).toEqual(['muteUntil']);
  });
});

describe('MuteChatDto published schema', () => {
  // @nestjs/swagger derives nothing from @IsInt/@Min/@Max, so the decorator has to state all of them.
  it('publishes muteUntil as a nullable integer between 1 and the largest safe integer', () => {
    expect(Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, MuteChatDto.prototype, 'muteUntil')).toMatchObject({
      type: 'integer',
      nullable: true,
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });
});

// Both engines take every value up to the largest safe integer, which some clients send for a mute without an
// end. whatsapp-web.js converts the value through Date: up to the last JavaScript date (8.64e15) it is an exact
// expiry, and past it the date is invalid and the call becomes a mute with no end (-1). Baileys writes the
// number into an int64 and encodes it exactly. Past the largest safe integer a JSON number is no longer an
// exact integer, and the int64 wraps from 2^63 (1e300 encodes as 0).
describe('MuteChatDto muteUntil bound', () => {
  const muteUntilConstraints = async (muteUntil: unknown): Promise<string[]> => {
    const errors = await validate(plainToInstance(MuteChatDto, { chatId: '1234567890-123@g.us', muteUntil }));
    return errors.filter(e => e.property === 'muteUntil').flatMap(e => Object.keys(e.constraints ?? {}));
  };

  it.each([
    null,
    1,
    1_800_000_000_000,
    Date.UTC(2100, 0, 1),
    8_640_000_000_000_000,
    8_640_000_000_000_001,
    Number.MAX_SAFE_INTEGER,
  ])('accepts %s', async value => {
    expect(await muteUntilConstraints(value)).toEqual([]);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 1e16, 2 ** 63, 1e300])('refuses %s', async value => {
    expect(await muteUntilConstraints(value)).toEqual(['max']);
  });
});
