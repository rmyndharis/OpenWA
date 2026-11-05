import { ArgumentMetadata, BadRequestException, INestApplication, PipeTransform, ValidationPipe } from '@nestjs/common';
import { applyGlobalValidation, NulBodyPipe } from './app-validation';
import { ImportDataDto } from '../modules/infra/dto/import-data.dto';
import { SendBulkMessageDto } from '../modules/message/dto/bulk-message.dto';
import { SendTextMessageDto } from '../modules/message/dto/send-message.dto';

// PostgreSQL rejects U+0000 in every text and varchar value and bound parameter, so a body string
// holding one failed the lookup or write behind the route as a 500.
describe('NulBodyPipe', () => {
  const pipe = new NulBodyPipe();

  it('refuses a body holding a NUL character at any depth', () => {
    const body = { messages: [{ chatId: 'a@c.us', variables: { name: 'x\u0000' } }] };
    expect(() => pipe.transform(body, { type: 'body', metatype: SendBulkMessageDto })).toThrow(BadRequestException);
  });

  it('passes a body without one, and leaves the path and query to the URL refusal', () => {
    const body = { messages: [{ chatId: 'a@c.us', variables: { name: 'x' } }] };
    expect(pipe.transform(body, { type: 'body', metatype: SendBulkMessageDto })).toBe(body);
    expect(pipe.transform('x\u0000', { type: 'param', metatype: String, data: 'id' })).toBe('x\u0000');
  });

  // The restore writes backup rows verbatim, and a SQLite backup may hold a NUL in a stored message.
  it('lets a restore body through', () => {
    const backup = { tables: { messages: [{ body: 'a\u0000b' }] } };
    expect(pipe.transform(backup, { type: 'body', metatype: ImportDataDto })).toBe(backup);
  });
});

// class-transformer copies every array element and every object key of a body before a validator can refuse it, and
// de-duplicates the keys of each object with a scan per key. A body that pads either costs seconds to minutes of
// event-loop time, so a width past any real request is refused first, for about the cost of reading it.
describe('the global pipes ahead of the DTO transform', () => {
  const ARRAY_LIMIT = 'Request body must not hold an array of more than 10000 items';
  const OBJECT_LIMIT = 'Request body must not hold an object of more than 1000 keys';
  const TOTAL_LIMIT = 'Request body must not hold more than 250000 array items and object keys in all';
  const body = (type: ArgumentMetadata['type'], metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
    type,
    metatype,
  });

  /** The pipes the app installs, in the order Nest runs them. */
  const installedPipes = (): PipeTransform[] => {
    const useGlobalPipes = jest.fn();
    applyGlobalValidation({ setGlobalPrefix: jest.fn(), useGlobalPipes } as unknown as INestApplication);
    return useGlobalPipes.mock.calls[0] as PipeTransform[];
  };
  const runAll = async (value: unknown, metadata: ArgumentMetadata): Promise<unknown> => {
    let current = value;
    for (const pipe of installedPipes()) current = await pipe.transform(current, metadata);
    return current;
  };
  const text = (extra: Record<string, unknown>): Record<string, unknown> => ({
    chatId: '628123456789@c.us',
    text: 'hi',
    ...extra,
  });
  const list = (length: number): number[] => Array.from({ length }, () => 1);
  const keys = (count: number): Record<string, number> =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, 1]));

  afterEach(() => jest.restoreAllMocks());

  it('runs the width bound first, then the validation pipe, then the NUL refusal', () => {
    expect(installedPipes().map(pipe => pipe.constructor.name)).toEqual([
      'BodyWidthPipe',
      'ValidationPipe',
      'NulBodyPipe',
    ]);
  });

  describe.each([
    ['an array past the array limit', text({ mentions: list(10_001) }), ARRAY_LIMIT],
    [
      'an array past it nested anywhere, in a key the DTO does not declare',
      text({ junk: { deeper: [{ list: list(10_001) }] } }),
      ARRAY_LIMIT,
    ],
    [
      'an object past the key limit, which the transform would scan once per key',
      text({ extra: keys(1_001) }),
      OBJECT_LIMIT,
    ],
    [
      'many small arrays that add up past the total',
      text({ junk: Array.from({ length: 26 }, () => list(9_999)) }),
      TOTAL_LIMIT,
    ],
  ])('a DTO body with %s', (_label, padded, message) => {
    it('is refused with 400 naming the limit, before the validation pipe runs', async () => {
      const transform = jest.spyOn(ValidationPipe.prototype, 'transform');

      await expect(runAll(padded, body('body', SendTextMessageDto))).rejects.toThrow(new BadRequestException(message));
      expect(transform).not.toHaveBeenCalled();
    });
  });

  it('leaves a body just under each limit to the limits of its own DTO', async () => {
    const transform = jest.spyOn(ValidationPipe.prototype, 'transform');
    const pipe = installedPipes()[0];
    const justUnder = [
      text({ mentions: list(10_000) }),
      text({ extra: keys(1_000) }),
      text({ junk: Array.from({ length: 24 }, () => list(9_999)) }),
    ];

    for (const padded of justUnder) expect(await pipe.transform(padded, body('body', SendTextMessageDto))).toBe(padded);
    await expect(runAll(justUnder[0], body('body', SendTextMessageDto))).rejects.toMatchObject({
      response: { message: expect.arrayContaining(['mentions must contain no more than 1024 elements']) as string[] },
    });
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a body no DTO defines', body('body', Object)],
    ['a body with no declared type', body('body', undefined)],
    ['a query', body('query', SendTextMessageDto)],
    ['a path parameter', body('param', String)],
  ])('does not look at %s', async (_label, metadata) => {
    const wide = { list: list(20_000), map: keys(20_000), many: Array.from({ length: 30 }, () => list(9_999)) };
    const pipe = installedPipes()[0];

    expect(await pipe.transform(wide, metadata)).toBe(wide);
  });

  // The restore posts the export file whole, and a table can hold far more rows than any request carries.
  it('lets a restore past every limit through', async () => {
    const backup = { tables: { messages: Array.from({ length: 260_000 }, () => ({})), webhooks: [] } };

    const restored = (await runAll(backup, body('body', ImportDataDto))) as ImportDataDto;

    expect((restored.tables as { messages: unknown[] }).messages).toHaveLength(260_000);
  }, 30_000);

  // 100 recipients, each tagging the most the single-send routes allow: the largest body the API documents.
  it('still validates a bulk send at its documented maximum', async () => {
    const messages = Array.from({ length: 100 }, (_, message) => ({
      chatId: '628123456789@c.us',
      type: 'text',
      content: {
        text: 'hi',
        mentions: Array.from({ length: 1024 }, (_, mention) => `${628000000000 + message * 1024 + mention}@c.us`),
      },
    }));

    const validated = (await runAll({ messages }, body('body', SendBulkMessageDto))) as SendBulkMessageDto;

    expect(validated.messages).toHaveLength(100);
  });
});
