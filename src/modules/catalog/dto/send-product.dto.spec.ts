import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PRODUCT_ID_MAX_LENGTH, SendProductDto } from './send-product.dto';
import { MESSAGE_TEXT_MAX_LENGTH } from '../../message/dto/send-message.dto';

/** The constraints that failed, keyed by property; empty when the payload is valid. */
const failures = async (body: object): Promise<Record<string, string[]>> => {
  const errors = await validate(plainToInstance(SendProductDto, body, { enableImplicitConversion: true }));
  return Object.fromEntries(errors.map(e => [e.property, Object.keys(e.constraints ?? {})]));
};

describe('SendProductDto', () => {
  const valid = { chatId: '628123@c.us', productId: 'prod-1', body: 'Back in stock!' };

  it('accepts a product send with or without a body', async () => {
    expect(await failures(valid)).toEqual({});
    expect(await failures({ chatId: valid.chatId, productId: valid.productId })).toEqual({});
    expect(await failures({ ...valid, body: '' })).toEqual({});
  });

  it('rejects an empty chatId or productId', async () => {
    expect(await failures({ ...valid, chatId: '' })).toEqual({ chatId: ['isNotEmpty'] });
    expect(await failures({ ...valid, productId: '' })).toEqual({ productId: ['isNotEmpty'] });
  });

  it('caps the productId length', async () => {
    expect(await failures({ ...valid, productId: 'p'.repeat(PRODUCT_ID_MAX_LENGTH) })).toEqual({});
    expect(await failures({ ...valid, productId: 'p'.repeat(PRODUCT_ID_MAX_LENGTH + 1) })).toEqual({
      productId: ['maxLength'],
    });
  });

  it('caps the body at the text-message limit', async () => {
    expect(await failures({ ...valid, body: 'b'.repeat(MESSAGE_TEXT_MAX_LENGTH) })).toEqual({});
    expect(await failures({ ...valid, body: 'b'.repeat(MESSAGE_TEXT_MAX_LENGTH + 1) })).toEqual({
      body: ['maxLength'],
    });
  });
});
