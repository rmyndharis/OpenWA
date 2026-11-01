import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RedriveWebhookDeliveriesDto } from '../../modules/webhook/dto/webhook.dto';
import { SearchQueryDto } from '../../modules/search/dto/search-query.dto';
import { ProductQueryDto } from '../../modules/catalog/dto/send-product.dto';
import { SendBulkMessageDto } from '../../modules/message/dto/bulk-message.dto';

const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };
const PIPE_VALIDATOR_OPTS = { whitelist: true, forbidNonWhitelisted: true };

describe('DTO numeric fields with positive minimums reject boolean and blank inputs without coercing', () => {
  it.each([
    ['RedriveWebhookDeliveriesDto.limit', RedriveWebhookDeliveriesDto, 'limit'],
    ['SearchQueryDto.limit', SearchQueryDto, 'limit'],
    ['ProductQueryDto.page', ProductQueryDto, 'page'],
    ['ProductQueryDto.limit', ProductQueryDto, 'limit'],
  ] as const)('%s rejects boolean true instead of coercing it to 1', async (_label, cls, prop) => {
    const instance = plainToInstance(cls, { [prop]: true }, PIPE_TRANSFORM_OPTS);
    const errors = await validate(instance, PIPE_VALIDATOR_OPTS);
    const propErrors = errors.filter(e => e.property === prop);

    expect((instance as Record<string, unknown>)[prop]).toBe(true);
    expect(propErrors.length).toBeGreaterThan(0);
  });

  it('SendBulkMessageDto.options.delayBetweenMessages leaves blank and boolean inputs uncoerced so @IsNumber rejects them', async () => {
    for (const raw of ['', true] as const) {
      const instance = plainToInstance(
        SendBulkMessageDto,
        { options: { delayBetweenMessages: raw } },
        PIPE_TRANSFORM_OPTS,
      );
      expect((instance.options as unknown as Record<string, unknown>).delayBetweenMessages).toBe(raw);
      const errors = await validate(instance, PIPE_VALIDATOR_OPTS);
      const optionErrors = errors.find(e => e.property === 'options')?.children ?? [];
      expect(optionErrors.find(e => e.property === 'delayBetweenMessages')?.constraints).toHaveProperty('isNumber');
    }
  });
});
