import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateChannelDto } from './create-channel.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

const property = (name: string) =>
  Reflect.getMetadata('swagger/apiModelProperties', CreateChannelDto.prototype, name) as { maxLength?: number };

// The options the global ValidationPipe runs with, so a body is judged the way a request is.
const { transformOptions, ...pipeOptions } = GLOBAL_VALIDATION_OPTIONS;

/** The constraints that failed, keyed by property; empty when the body is valid. */
const failures = async (body: object): Promise<Record<string, string[]>> => {
  const errors = await validate(plainToInstance(CreateChannelDto, body, transformOptions), pipeOptions);
  return Object.fromEntries(errors.map(e => [e.property, Object.keys(e.constraints ?? {})]));
};

// The validator caps both fields and the contract has to publish the same caps, or a generated client is told
// one bound while the server enforces another. Each case judges a value at the bound and one past it with the
// real validator, and reads the published value, so neither side can drift without a failure.
describe('CreateChannelDto contract', () => {
  it.each([
    ['name', 100],
    ['description', 2048],
  ])('%s: the validator and the published contract cap at %d', async (name, max) => {
    expect(property(name).maxLength).toBe(max);
    expect(await failures({ name: 'n', [name]: 'x'.repeat(max) })).toEqual({});
    expect(await failures({ name: 'n', [name]: 'x'.repeat(max + 1) })).toEqual({ [name]: ['maxLength'] });
  });

  it('refuses an empty name and lets the description be omitted', async () => {
    expect(await failures({ name: '' })).toEqual({ name: ['isNotEmpty'] });
    expect(await failures({ name: 'Product updates' })).toEqual({});
  });
});
