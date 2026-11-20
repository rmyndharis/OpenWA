import { DECORATORS } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateWebhookDto, RedriveWebhookDeliveriesDto, UpdateWebhookDto } from './webhook.dto';

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

  it("CreateWebhookDto: accepts 'status.received'", async () => {
    expect(
      await errorsFor(CreateWebhookDto, { url: 'https://x.example/hook', events: ['status.received'] }),
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

  // These columns are NOT NULL: @IsOptional let null through and save() then answered 500.
  it.each(['url', 'events', 'headers', 'active', 'retryCount'])(
    'UpdateWebhookDto: rejects null for the NOT NULL field %s',
    async field => {
      const errs = await errorsFor(UpdateWebhookDto, { [field]: null });
      expect(errs.map(e => e.property)).toEqual([field]);
    },
  );

  it('UpdateWebhookDto: still accepts an omitted field and a null filters (nullable column)', async () => {
    expect(await errorsFor(UpdateWebhookDto, {})).toHaveLength(0);
    expect(await errorsFor(UpdateWebhookDto, { filters: null })).toHaveLength(0);
  });

  // The secret column is nullable and the service stores null for both spellings of "clear it", so both are accepted
  // and the published text names both; a secret under the floor is still refused.
  it('UpdateWebhookDto: clears the secret with an empty string or null, and the schema says so', async () => {
    expect(await errorsFor(UpdateWebhookDto, { secret: '' })).toHaveLength(0);
    expect(await errorsFor(UpdateWebhookDto, { secret: null })).toHaveLength(0);
    expect((await errorsFor(UpdateWebhookDto, { secret: 'short' })).map(e => e.property)).toEqual(['secret']);

    const meta = Reflect.getMetadata('swagger/apiModelProperties', UpdateWebhookDto.prototype, 'secret') as {
      description?: string;
    };
    expect(meta.description).toContain('an empty string or null to clear it');
  });

  // WebhookService.update applies filters only when the field is present, so an update that omits it
  // keeps the stored filter. The published schema must not offer omission as a way to clear one.
  it('UpdateWebhookDto: documents that an omitted filters keeps the stored one', () => {
    const descriptionOf = (target: object): string | undefined =>
      (Reflect.getMetadata('swagger/apiModelProperties', target, 'filters') as { description?: string } | undefined)
        ?.description;

    expect(descriptionOf(UpdateWebhookDto.prototype)).toContain('Omit to keep the stored filters');
    expect(descriptionOf(UpdateWebhookDto.prototype)).not.toContain('Omit or null to fire');
    expect(descriptionOf(CreateWebhookDto.prototype)).toContain('Omit or null to fire');
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

  // The HTTP client joins case-variant names into one comma-separated value, so neither value is
  // sent as written and a receiver checking one credential sees both.
  it('rejects two header names that differ only in case, on create and update', async () => {
    const headers = { Authorization: 'Bearer a', authorization: 'Bearer b' };
    const create = await errorsFor(CreateWebhookDto, { url: 'https://x.example/hook', headers });
    expect(create.some(e => e.property === 'headers')).toBe(true);
    const update = await errorsFor(UpdateWebhookDto, { headers });
    expect(update.some(e => e.property === 'headers')).toBe(true);
    expect(await errorsFor(UpdateWebhookDto, { headers: { 'X-A': '1', 'X-B': '2' } })).toHaveLength(0);
  });

  it('UpdateWebhookDto applies the same header validation', async () => {
    const errs = await errorsFor(UpdateWebhookDto, { headers: { 'X-Evil': 'a\nb' } });
    expect(errs.some(e => e.property === 'headers')).toBe(true);
  });

  // Header values go out as Latin-1 bytes; a wider code unit throws inside the HTTP client on every
  // delivery, so it must be refused when the webhook is saved.
  it.each(['Caf\u00e9 \u2192 Norte', '\u6771\u4eac', 'hi \u{1F600}'])(
    'rejects a header value outside Latin-1 (%s) on create and update',
    async value => {
      const create = await errorsFor(CreateWebhookDto, {
        url: 'https://example.com/hook',
        headers: { 'X-Tenant': value },
      });
      expect(create.some(e => e.property === 'headers')).toBe(true);
      const update = await errorsFor(UpdateWebhookDto, { headers: { 'X-Tenant': value } });
      expect(update.some(e => e.property === 'headers')).toBe(true);
    },
  );

  it('accepts a Latin-1 header value on create and update', async () => {
    const headers = { 'X-Tenant': 'Caf\u00e9 Norte \u00ff' };
    const create = await errorsFor(CreateWebhookDto, { url: 'https://example.com/hook', headers });
    expect(create.some(e => e.property === 'headers')).toBe(false);
    const update = await errorsFor(UpdateWebhookDto, { headers });
    expect(update.some(e => e.property === 'headers')).toBe(false);
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

describe('webhook DTO url validation', () => {
  // The column is varchar(2048); PostgreSQL refuses a longer value on insert with a 500.
  const longUrl = (length: number) => 'https://x.example/' + 'a'.repeat(length - 'https://x.example/'.length);

  const dtos: [string, new () => object][] = [
    ['CreateWebhookDto', CreateWebhookDto],
    ['UpdateWebhookDto', UpdateWebhookDto],
  ];

  it.each(dtos)('%s accepts http(s) URLs, dotless hosts included', async (_name, cls) => {
    for (const url of ['https://x.example/hook', 'http://localhost:3000/hook', longUrl(2048)]) {
      expect(await errorsFor(cls, { url })).toHaveLength(0);
    }
  });

  it.each(dtos)('%s rejects scheme-less, non-http(s) and over-length URLs', async (_name, cls) => {
    for (const url of [
      'example.com/hook',
      'localhost:3000/hook',
      'user:pass@host/x',
      'ftp://x.example/y',
      longUrl(2049),
    ]) {
      const errs = await errorsFor(cls, { url });
      expect(errs.some(e => e.property === 'url')).toBe(true);
    }
  });
});

// The validators cap the redrive selection; the schema has to say so, or a client generated from it
// sends a list the server answers with a 400.
describe('RedriveWebhookDeliveriesDto published schema', () => {
  const published = (key: string): Record<string, unknown> | undefined =>
    Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, RedriveWebhookDeliveriesDto.prototype, key) as
      Record<string, unknown> | undefined;

  it('publishes the bounds of the id list and the limit that the validators enforce', async () => {
    expect(published('ids')).toMatchObject({ maxItems: 500, items: { type: 'string', maxLength: 128 } });
    expect(published('limit')).toMatchObject({ minimum: 1, maximum: 500 });

    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    expect((await errorsFor(RedriveWebhookDeliveriesDto, { ids })).some(e => e.property === 'ids')).toBe(true);
    expect(await errorsFor(RedriveWebhookDeliveriesDto, { ids: ids.slice(0, 500), limit: 500 })).toHaveLength(0);
  });
});
