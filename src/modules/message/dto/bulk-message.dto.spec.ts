import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendBulkMessageDto } from './bulk-message.dto';

// Mirror the global ValidationPipe (main.ts): whitelist + forbidNonWhitelisted strip/reject unknown
// props. Before the nested media objects were typed DTOs they were bare object literals, so these
// options could not reach inside a media object — junk in `content.image` passed straight through
// and was persisted verbatim.
const validateBulk = (obj: unknown) =>
  validate(plainToInstance(SendBulkMessageDto, obj), { whitelist: true, forbidNonWhitelisted: true });

const imageItem = (image: unknown) => ({
  messages: [{ chatId: 'c@c.us', type: 'image', content: { image } }],
});

describe('SendBulkMessageDto nested media validation', () => {
  it('accepts a well-formed base64 media object', async () => {
    expect(await validateBulk(imageItem({ base64: 'AAAA', mimetype: 'image/png' }))).toHaveLength(0);
  });

  it('rejects an unknown property inside a media object', async () => {
    expect((await validateBulk(imageItem({ base64: 'AAAA', evil: 'x' }))).length).toBeGreaterThan(0);
  });

  it('rejects a non-string base64 inside a media object', async () => {
    expect((await validateBulk(imageItem({ base64: 12345 }))).length).toBeGreaterThan(0);
  });
});

const textItem = (text: string, extra: Record<string, unknown> = {}) => ({
  messages: [{ chatId: 'c@c.us', type: 'text', content: { text }, ...extra }],
});

describe('SendBulkMessageDto content length + variables validation', () => {
  it('accepts text at the 4096 cap and rejects beyond it (parity with single-send)', async () => {
    expect(await validateBulk(textItem('a'.repeat(4096)))).toHaveLength(0);
    expect((await validateBulk(textItem('a'.repeat(4097)))).length).toBeGreaterThan(0);
  });

  it('accepts an object variables map and rejects a non-object', async () => {
    expect(await validateBulk(textItem('hi', { variables: { name: 'Alice' } }))).toHaveLength(0);
    expect((await validateBulk(textItem('hi', { variables: 'oops' }))).length).toBeGreaterThan(0);
    expect((await validateBulk(textItem('hi', { variables: [1, 2, 3] }))).length).toBeGreaterThan(0);
  });
});
