import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { SendLocationDto, ReactMessageDto, DeleteMessageDto, ForwardMessageDto } from './message-actions.dto';

/**
 * Regression locks: these endpoints previously took inline @Body literals (no
 * runtime validation). e2e is deferred (broken harness), so we validate the
 * decorators directly via class-validator.
 */
function errorsFor<T extends object>(cls: new () => T, obj: object): Promise<ValidationError[]> {
  return validate(plainToInstance(cls, obj));
}

describe('message action DTOs', () => {
  it('SendLocationDto: valid coordinates pass', async () => {
    expect(await errorsFor(SendLocationDto, { chatId: 'x@c.us', latitude: -6.2088, longitude: 106.8456 })).toHaveLength(
      0,
    );
  });

  it('SendLocationDto: missing chatId is rejected', async () => {
    const errs = await errorsFor(SendLocationDto, { latitude: -6.2, longitude: 106.8 });
    expect(errs.some(e => e.property === 'chatId')).toBe(true);
  });

  it('SendLocationDto: non-numeric latitude is rejected', async () => {
    const errs = await errorsFor(SendLocationDto, { chatId: 'x@c.us', latitude: 'abc', longitude: 106.8 });
    expect(errs.some(e => e.property === 'latitude')).toBe(true);
  });

  it('SendLocationDto: out-of-range latitude is rejected', async () => {
    const errs = await errorsFor(SendLocationDto, { chatId: 'x@c.us', latitude: 999, longitude: 106.8 });
    expect(errs.some(e => e.property === 'latitude')).toBe(true);
  });

  it('ReactMessageDto: empty emoji is VALID (removes the reaction — foot-gun preserved)', async () => {
    expect(await errorsFor(ReactMessageDto, { chatId: 'x@c.us', messageId: 'm1', emoji: '' })).toHaveLength(0);
  });

  it('ReactMessageDto: missing messageId is rejected', async () => {
    const errs = await errorsFor(ReactMessageDto, { chatId: 'x@c.us', emoji: '👍' });
    expect(errs.some(e => e.property === 'messageId')).toBe(true);
  });

  it('DeleteMessageDto: forEveryone is optional', async () => {
    expect(await errorsFor(DeleteMessageDto, { chatId: 'x@c.us', messageId: 'm1' })).toHaveLength(0);
  });

  it('ForwardMessageDto: requires all three ids', async () => {
    const errs = await errorsFor(ForwardMessageDto, { fromChatId: 'a@c.us' });
    expect(errs.some(e => e.property === 'toChatId')).toBe(true);
    expect(errs.some(e => e.property === 'messageId')).toBe(true);
  });
});
