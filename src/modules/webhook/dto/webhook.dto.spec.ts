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

describe('webhook DTO custom-header validation', () => {
  it('accepts a flat string->string header map', async () => {
    const errs = await errorsFor(CreateWebhookDto, {
      url: 'https://x.example/hook',
      headers: { 'X-Custom-Header': 'value', Authorization: 'Bearer abc' },
    });
    expect(errs.some(e => e.property === 'headers')).toBe(false);
  });

  it('rejects a header value containing CR/LF (header injection)', async () => {
    const errs = await errorsFor(CreateWebhookDto, {
      url: 'https://x.example/hook',
      headers: { 'X-Evil': 'a\r\nX-Injected: 1' },
    });
    expect(errs.some(e => e.property === 'headers')).toBe(true);
  });

  it('rejects a non-string header value', async () => {
    const errs = await errorsFor(CreateWebhookDto, {
      url: 'https://x.example/hook',
      headers: { 'X-Num': 123 as unknown as string },
    });
    expect(errs.some(e => e.property === 'headers')).toBe(true);
  });

  it('rejects an invalid header name', async () => {
    const errs = await errorsFor(CreateWebhookDto, {
      url: 'https://x.example/hook',
      headers: { 'Bad Header!': 'v' },
    });
    expect(errs.some(e => e.property === 'headers')).toBe(true);
  });

  it('UpdateWebhookDto applies the same header validation', async () => {
    const errs = await errorsFor(UpdateWebhookDto, { headers: { 'X-Evil': 'a\nb' } });
    expect(errs.some(e => e.property === 'headers')).toBe(true);
  });
});

describe('webhook DTO filter validation', () => {
  const withFilters = (conditions: unknown) => ({ url: 'https://x.example/hook', filters: { conditions } });

  it('accepts a webhook with no filters (optional)', async () => {
    expect(await errorsFor(CreateWebhookDto, { url: 'https://x.example/hook' })).toHaveLength(0);
  });

  it('accepts valid sender + body conditions', async () => {
    const errs = await errorsFor(
      CreateWebhookDto,
      withFilters([
        { field: 'sender', operator: 'is', value: ['123@c.us'] },
        { field: 'body', operator: 'contains', value: 'invoice' },
      ]),
    );
    expect(errs).toHaveLength(0);
  });

  it('rejects an unknown field', async () => {
    const errs = await errorsFor(CreateWebhookDto, withFilters([{ field: 'nope', operator: 'is', value: ['x'] }]));
    expect(errs.some(e => e.property === 'filters')).toBe(true);
  });

  it('rejects an operator not allowed for the field', async () => {
    const errs = await errorsFor(
      CreateWebhookDto,
      withFilters([{ field: 'sender', operator: 'contains', value: ['x'] }]),
    );
    expect(errs.some(e => e.property === 'filters')).toBe(true);
  });

  it('rejects an invalid message type value', async () => {
    const errs = await errorsFor(CreateWebhookDto, withFilters([{ field: 'type', operator: 'is', value: ['gif'] }]));
    expect(errs.some(e => e.property === 'filters')).toBe(true);
  });

  it('rejects the removed "matches" (regex) operator', async () => {
    const errs = await errorsFor(
      CreateWebhookDto,
      withFilters([{ field: 'body', operator: 'matches', value: '^order' }]),
    );
    expect(errs.some(e => e.property === 'filters')).toBe(true);
  });

  it('rejects a non-boolean value for a boolean field', async () => {
    const errs = await errorsFor(CreateWebhookDto, withFilters([{ field: 'isGroup', operator: 'is', value: 'yes' }]));
    expect(errs.some(e => e.property === 'filters')).toBe(true);
  });
});
