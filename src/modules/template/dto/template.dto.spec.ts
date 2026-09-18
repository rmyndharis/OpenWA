import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateTemplateDto } from './template.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

describe('UpdateTemplateDto', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const through = (value: object): Promise<unknown> =>
    pipe.transform(value, { type: 'body', metatype: UpdateTemplateDto });

  it('accepts a partial update that leaves name and body out', async () => {
    await expect(through({ footer: 'bye' })).resolves.toMatchObject({ footer: 'bye' });
  });

  // name and body are NOT NULL columns: an explicit null that passed validation reached save() and
  // answered 500.
  it.each(['name', 'body'])('rejects an explicit null %s', async field => {
    await expect(through({ [field]: null })).rejects.toBeInstanceOf(BadRequestException);
  });

  // header and footer are nullable columns, and @IsOptional skips null as well as undefined, so an
  // explicit null reaches update() and clears the stored value. docs/06 documents that; pin it here
  // so the table and the behaviour cannot drift apart.
  it.each(['header', 'footer'])('accepts an explicit null %s, which clears the stored value', async field => {
    await expect(through({ [field]: null })).resolves.toEqual({ [field]: null });
  });
});
