import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import {
  SendLocationDto,
  SendPollDto,
  ReactMessageDto,
  DeleteMessageDto,
  ForwardMessageDto,
  EditMessageDto,
} from './message-actions.dto';

/**
 * Regression locks: these endpoints previously took inline @Body literals (no
 * runtime validation). e2e is deferred (broken harness), so we validate the
 * decorators directly via class-validator.
 */
// The transform option has to match src/config/app-validation.ts. Without it these specs exercise a
// stricter pipe than the one that actually runs, so a payload rejected here can still be accepted in
// production — which is exactly how a stringly-typed boolean stayed invisible.
const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };

function errorsFor<T extends object>(cls: new () => T, obj: object): Promise<ValidationError[]> {
  return validate(plainToInstance(cls, obj, PIPE_TRANSFORM_OPTS));
}

function instanceFor<T extends object>(cls: new () => T, obj: object): T {
  return plainToInstance(cls, obj, PIPE_TRANSFORM_OPTS);
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

  it('SendPollDto: a valid poll passes', async () => {
    expect(
      await errorsFor(SendPollDto, { chatId: '120363000@g.us', name: 'Where?', options: ['Park', 'Beach'] }),
    ).toHaveLength(0);
  });

  it('SendPollDto: fewer than 2 options is rejected', async () => {
    const errs = await errorsFor(SendPollDto, { chatId: 'x@c.us', name: 'Q', options: ['Only one'] });
    expect(errs.some(e => e.property === 'options')).toBe(true);
  });

  it('SendPollDto: more than 12 options is rejected (WhatsApp cap)', async () => {
    const errs = await errorsFor(SendPollDto, {
      chatId: 'x@c.us',
      name: 'Q',
      options: Array.from({ length: 13 }, (_, i) => `Opt ${i}`),
    });
    expect(errs.some(e => e.property === 'options')).toBe(true);
  });

  it('SendPollDto: an empty option is rejected', async () => {
    const errs = await errorsFor(SendPollDto, { chatId: 'x@c.us', name: 'Q', options: ['A', ''] });
    expect(errs.some(e => e.property === 'options')).toBe(true);
  });

  it('SendPollDto: allowMultipleAnswers must be boolean when present', async () => {
    const errs = await errorsFor(SendPollDto, {
      chatId: 'x@c.us',
      name: 'Q',
      options: ['A', 'B'],
      allowMultipleAnswers: 'yes',
    });
    expect(errs.some(e => e.property === 'allowMultipleAnswers')).toBe(true);
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

  // The service defaults an absent forEveryone to true, so `false` is the only reason to send the
  // field at all. Asserting the VALUE, not just the error count: a form-encoded "false" read as
  // `true` would retract the message from the recipient instead of hiding it locally, and that
  // cannot be undone.
  it('DeleteMessageDto: a form-encoded "false" stays false', () => {
    const base = { chatId: 'x@c.us', messageId: 'm1' };
    expect(instanceFor(DeleteMessageDto, { ...base, forEveryone: 'false' }).forEveryone).toBe(false);
    expect(instanceFor(DeleteMessageDto, { ...base, forEveryone: 'true' }).forEveryone).toBe(true);
    expect(instanceFor(DeleteMessageDto, { ...base, forEveryone: false }).forEveryone).toBe(false);
    expect(instanceFor(DeleteMessageDto, { ...base, forEveryone: true }).forEveryone).toBe(true);
  });

  it('DeleteMessageDto: rejects an ambiguous forEveryone rather than defaulting it to true', async () => {
    for (const value of ['yes', 'no', '0', '1', 'FALSE']) {
      const errs = await errorsFor(DeleteMessageDto, { chatId: 'x@c.us', messageId: 'm1', forEveryone: value });
      expect(errs.some(e => e.property === 'forEveryone')).toBe(true);
    }
  });

  it('ForwardMessageDto: requires all three ids', async () => {
    const errs = await errorsFor(ForwardMessageDto, { fromChatId: 'a@c.us' });
    expect(errs.some(e => e.property === 'toChatId')).toBe(true);
    expect(errs.some(e => e.property === 'messageId')).toBe(true);
  });

  it('EditMessageDto: a valid edit passes', async () => {
    expect(await errorsFor(EditMessageDto, { chatId: 'x@c.us', messageId: 'm1', body: 'new text' })).toHaveLength(0);
  });

  it('EditMessageDto: an empty body is rejected (an edit needs text)', async () => {
    const errs = await errorsFor(EditMessageDto, { chatId: 'x@c.us', messageId: 'm1', body: '' });
    expect(errs.some(e => e.property === 'body')).toBe(true);
  });

  it('EditMessageDto: a body over 4096 chars is rejected (same cap as send-text)', async () => {
    const errs = await errorsFor(EditMessageDto, { chatId: 'x@c.us', messageId: 'm1', body: 'x'.repeat(4097) });
    expect(errs.some(e => e.property === 'body')).toBe(true);
  });

  it('EditMessageDto: missing messageId is rejected', async () => {
    const errs = await errorsFor(EditMessageDto, { chatId: 'x@c.us', body: 'new text' });
    expect(errs.some(e => e.property === 'messageId')).toBe(true);
  });
});
