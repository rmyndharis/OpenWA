import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateCallLinkDto } from './create-call-link.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

describe('CreateCallLinkDto', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const through = (value: object): Promise<unknown> =>
    pipe.transform(value, { type: 'body', metatype: CreateCallLinkDto });

  // Past the largest valid JS Date, whatsapp-web.js builds an Invalid Date and Baileys an
  // exponent-notation start time, so the request must stop here with a 400.
  it.each([8_640_000_000_000_001, 1e16, 1e300])('rejects startTime %d with a 400', async startTime => {
    await expect(through({ type: 'video', startTime })).rejects.toBeInstanceOf(BadRequestException);
  });

  // The global pipe converts by declared type, so a boolean would otherwise read as the number 1.
  it.each([true, false, '', ' ', 'soon'])('rejects startTime %p with a 400', async startTime => {
    await expect(through({ type: 'video', startTime })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a start time sent as a numeric string', async () => {
    await expect(through({ type: 'video', startTime: '1800000000000' })).resolves.toEqual({
      type: 'video',
      startTime: 1_800_000_000_000,
    });
  });

  it('accepts the largest valid Date', async () => {
    await expect(through({ type: 'video', startTime: 8_640_000_000_000_000 })).resolves.toEqual({
      type: 'video',
      startTime: 8_640_000_000_000_000,
    });
  });
});
