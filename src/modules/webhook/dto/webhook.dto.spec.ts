import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';

/** Regression locks: webhook `events[]` must be constrained to known types + '*'. */
function errorsFor<T extends object>(cls: new () => T, obj: object): Promise<ValidationError[]> {
  return validate(plainToInstance(cls, obj));
}

describe('webhook DTO event validation', () => {
  it('CreateWebhookDto: rejects an unknown/typo event', async () => {
    const errs = await errorsFor(CreateWebhookDto, { url: 'https://x.example/hook', events: ['mesage.received'] });
    expect(errs.some(e => e.property === 'events')).toBe(true);
  });

  it("CreateWebhookDto: accepts the '*' wildcard (must stay valid)", async () => {
    expect(await errorsFor(CreateWebhookDto, { url: 'https://x.example/hook', events: ['*'] })).toHaveLength(0);
  });

  it('CreateWebhookDto: accepts known events', async () => {
    expect(
      await errorsFor(CreateWebhookDto, { url: 'https://x.example/hook', events: ['message.received', 'group.join'] }),
    ).toHaveLength(0);
  });

  it('UpdateWebhookDto: rejects an empty events array (ArrayMinSize parity)', async () => {
    const errs = await errorsFor(UpdateWebhookDto, { events: [] });
    expect(errs.some(e => e.property === 'events')).toBe(true);
  });

  it('UpdateWebhookDto: rejects an unknown event', async () => {
    const errs = await errorsFor(UpdateWebhookDto, { events: ['nope'] });
    expect(errs.some(e => e.property === 'events')).toBe(true);
  });
});
