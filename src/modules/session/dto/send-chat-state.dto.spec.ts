import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';
import { SendChatStateDto } from './send-chat-state.dto';

// The indicator the typing route sends is one of the three ChatState words. Anything else, `composing`
// (the word a presence report uses) included, would reach the engines as a state they do not know.
describe('SendChatStateDto state', () => {
  const failing = async (body: object): Promise<string[]> =>
    (
      await validate(
        plainToInstance(
          SendChatStateDto,
          { chatId: '1234567890@c.us', ...body },
          GLOBAL_VALIDATION_OPTIONS.transformOptions,
        ),
        GLOBAL_VALIDATION_OPTIONS,
      )
    ).map(error => error.property);

  it.each(['typing', 'recording', 'paused'])('accepts %s', async state => {
    expect(await failing({ state })).toEqual([]);
  });

  it.each([
    ['composing', 'composing'],
    ['available', 'available'],
    ['a different case', 'TYPING'],
    ['an empty string', ''],
    ['a number', 1],
    ['null', null],
  ])('rejects %s', async (_label, state) => {
    expect(await failing({ state })).toEqual(['state']);
  });

  it('rejects a missing state', async () => {
    expect(await failing({})).toEqual(['state']);
  });

  it('rejects a missing chatId', async () => {
    const errors = await validate(
      plainToInstance(SendChatStateDto, { state: 'typing' }, GLOBAL_VALIDATION_OPTIONS.transformOptions),
      GLOBAL_VALIDATION_OPTIONS,
    );
    expect(errors.map(error => error.property)).toEqual(['chatId']);
  });
});
