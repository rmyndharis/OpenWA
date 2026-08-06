import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SearchQueryDto } from './search-query.dto';

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

  it('rejects limit < 1 (@Min(1))', () => {
    const dto = fromQuery({ q: 'hello', limit: '0' });
    expect(validateSync(dto).some(e => e.property === 'limit')).toBe(true);
  });

  it('rejects offset < 0 (@Min(0))', () => {
    const dto = fromQuery({ q: 'hello', offset: '-1' });
    expect(validateSync(dto).some(e => e.property === 'offset')).toBe(true);
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
});
