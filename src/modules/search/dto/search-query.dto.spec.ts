import { DECORATORS } from '@nestjs/swagger';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SearchQueryDto } from './search-query.dto';
import { SEARCH_OFFSET_MAX, SEARCH_QUERY_MAX_LENGTH } from '../search.constants';

describe('SearchQueryDto', () => {
  // Mirrors how the global ValidationPipe (transform:true + enableImplicitConversion) instantiates
  // the DTO from a query-string-shaped plain object: @Type(() => Number) coerces strings to numbers
  // before class-validator runs.
  const fromQuery = (query: Record<string, unknown>): SearchQueryDto => plainToInstance(SearchQueryDto, query);

  it('coerces numeric query-string fields to numbers', () => {
    const dto = fromQuery({ q: 'hello', limit: '5', offset: '10', dateFrom: '1000', dateTo: '2000' });
    expect(dto.limit).toBe(5);
    expect(dto.offset).toBe(10);
    expect(dto.dateFrom).toBe(1000);
    expect(dto.dateTo).toBe(2000);
  });

  it('rejects a non-numeric limit — the ?limit=abc → 400 path (Number(abc) is NaN, fails @IsNumber)', () => {
    const dto = fromQuery({ q: 'hello', limit: 'abc' });
    const errors = validateSync(dto);
    expect(errors.some(e => e.property === 'limit')).toBe(true);
  });

  it('rejects a non-numeric offset', () => {
    const dto = fromQuery({ q: 'hello', offset: 'xyz' });
    expect(validateSync(dto).some(e => e.property === 'offset')).toBe(true);
  });

  // Both are bound straight into LIMIT ? OFFSET ?, where SQLite and PostgreSQL reject a fraction with a
  // 500; the DTO must stop it as a 400.
  it('rejects a fractional limit or offset', () => {
    expect(validateSync(fromQuery({ q: 'hello', limit: '1.5' })).some(e => e.property === 'limit')).toBe(true);
    expect(validateSync(fromQuery({ q: 'hello', offset: '0.5' })).some(e => e.property === 'offset')).toBe(true);
  });

  it('rejects a q longer than SEARCH_QUERY_MAX_LENGTH and accepts one at the bound', () => {
    expect(validateSync(fromQuery({ q: 'a'.repeat(SEARCH_QUERY_MAX_LENGTH) }))).toHaveLength(0);
    expect(validateSync(fromQuery({ q: 'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 1) })).some(e => e.property === 'q')).toBe(
      true,
    );
  });

  // PostgreSQL refuses U+0000 in a bound parameter in either match mode, and SQLite's FTS5 in a contains query.
  it('rejects a q holding a NUL character', () => {
    const errors = validateSync(fromQuery({ q: `invoice${String.fromCharCode(0)}` }));
    expect(errors.map(e => [e.property, Object.keys(e.constraints ?? {})])).toEqual([['q', ['notContains']]]);
  });

  it('rejects limit < 1 (@Min(1))', () => {
    const dto = fromQuery({ q: 'hello', limit: '0' });
    expect(validateSync(dto).some(e => e.property === 'limit')).toBe(true);
  });

  it('rejects offset < 0 (@Min(0))', () => {
    const dto = fromQuery({ q: 'hello', offset: '-1' });
    expect(validateSync(dto).some(e => e.property === 'offset')).toBe(true);
  });

  it('rejects offset above SEARCH_OFFSET_MAX instead of letting the service clamp it to a repeated page', () => {
    expect(validateSync(fromQuery({ q: 'hello', offset: '100001' })).some(e => e.property === 'offset')).toBe(true);
    expect(validateSync(fromQuery({ q: 'hello', offset: '100000' }))).toHaveLength(0);
  });

  // The provider binds ceil(dateFrom / 1000) into a bigint column. A bound near 1e22 overflows it on
  // PostgreSQL (a 500 instead of a 400); the message list refuses the same values for since/until.
  describe.each(['dateFrom', 'dateTo'] as const)('%s', field => {
    const validate = (value: string): boolean => validateSync(fromQuery({ q: 'hello', [field]: value })).length === 0;

    it.each(['9300000000000000000000', '-9300000000000000000000', String(2 ** 53), String(-(2 ** 53))])(
      'rejects %s, which is beyond the safe integer range',
      value => {
        expect(validate(value)).toBe(false);
      },
    );

    it.each([String(Number.MAX_SAFE_INTEGER), String(-Number.MAX_SAFE_INTEGER), '0', '-1', '1700000000000.5'])(
      'accepts %s',
      value => {
        expect(validate(value)).toBe(true);
      },
    );
  });

  it('rejects an invalid direction (@IsEnum(MessageDirection))', () => {
    const dto = fromQuery({ q: 'hello', direction: 'sideways' });
    expect(validateSync(dto).some(e => e.property === 'direction')).toBe(true);
  });

  it('accepts a valid direction', () => {
    const dto = fromQuery({ q: 'hello', direction: 'incoming' });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects an empty q (@IsNotEmpty)', () => {
    const dto = fromQuery({ q: '' });
    expect(validateSync(dto).some(e => e.property === 'q')).toBe(true);
  });

  it('accepts a minimal valid query with only q', () => {
    const dto = fromQuery({ q: 'hello' });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('accepts both match modes and rejects any other value', () => {
    expect(validateSync(fromQuery({ q: 'hello', match: 'word' }))).toHaveLength(0);
    expect(validateSync(fromQuery({ q: 'hello', match: 'contains' }))).toHaveLength(0);
    expect(validateSync(fromQuery({ q: 'hello', match: 'fuzzy' })).some(e => e.property === 'match')).toBe(true);
  });

  // @nestjs/swagger derives no bounds from @IsInt/@Min/@Max, so the decorator has to state them.
  it('publishes limit and offset as bounded integers', () => {
    const published = (key: string): unknown =>
      Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, SearchQueryDto.prototype, key);
    expect(published('limit')).toMatchObject({ type: 'integer', minimum: 1 });
    expect(published('offset')).toMatchObject({ type: 'integer', minimum: 0, maximum: SEARCH_OFFSET_MAX });
  });

  it('publishes dateFrom and dateTo with the safe integer bounds they are validated against', () => {
    const published = (key: string): unknown =>
      Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, SearchQueryDto.prototype, key);
    for (const key of ['dateFrom', 'dateTo']) {
      expect(published(key)).toMatchObject({
        type: Number,
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      });
    }
  });
});
