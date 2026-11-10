import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { MEDIA_URL_MESSAGE } from '../../common/media/media-url';
import type { AuthService } from '../../modules/auth/auth.service';
import { defineTool, type AnyToolDescriptor } from './tool-descriptor';
import { allAgentTools, type AgentToolDeps } from './tools';
import { invokeTool } from './tool-invoker';

const tools = allAgentTools({
  session: {},
  message: {},
  contact: {},
  group: {},
  webhook: {},
  labels: {},
  automation: {},
} as unknown as AgentToolDeps);
const byName: Array<[string, AnyToolDescriptor]> = tools.map(tool => [tool.name, tool]);

const messageOf = (tool: AnyToolDescriptor, input: unknown): string => {
  const result = tool.inputSchema.safeParse(input);
  if (result.success) throw new Error('expected the input to be refused');
  return result.error.issues.map(issue => issue.message).join('; ');
};

describe('tool inputs refuse an argument they do not name', () => {
  it('covers the whole surface', () => {
    expect(tools.length).toBeGreaterThanOrEqual(52);
  });

  it.each(byName)('%s publishes additionalProperties: false', (_name, tool) => {
    const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as { additionalProperties?: unknown };
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(byName)('%s refuses an unknown argument and reports it as unrecognized', (_name, tool) => {
    const result = tool.inputSchema.safeParse({ sessionId: 's1', __notAnArgument: 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(issue => issue.code)).toContain('unrecognized_keys');
  });

  it('names the one argument it does not know', () => {
    const tool = byName.find(([name]) => name === 'SessionFindAll')![1];
    expect(messageOf(tool, { bogus: 1 })).toBe('Unrecognized key: "bogus"');
  });

  it('answers briefly however many names, or however long a name, the caller sends', () => {
    const tool = byName.find(([name]) => name === 'SessionFindAll')![1];
    const many = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`key${i}`, 1]));
    const message = messageOf(tool, { ...many, ['k'.repeat(1_000_000)]: 1 });

    expect(message.length).toBeLessThan(500);
    expect(message).toMatch(/^Unrecognized keys: "key0", /);
    expect(message).toMatch(/\(and 49996 more\)$/);
    expect(messageOf(tool, { ['k'.repeat(1_000_000)]: 1 }).length).toBeLessThan(100);
  });

  it('refuses an unknown key inside customLinkPreview too, with the same short message', () => {
    const text = byName.find(([name]) => name === 'MessageSendText')![1];
    const result = text.inputSchema.safeParse({
      sessionId: 's1',
      chatId: '628111@c.us',
      text: 'hi',
      customLinkPreview: { url: 'https://example.com', title: 't', thumbnail_url: 'x' },
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues.find(i => i.code === 'unrecognized_keys');
    expect(issue?.path).toEqual(['customLinkPreview']);
    expect(issue?.message).toBe('Unrecognized key: "thumbnail_url"');
    const schema = z.toJSONSchema(text.inputSchema, { io: 'input' }) as unknown as {
      properties: { customLinkPreview: { additionalProperties?: unknown } };
    };
    expect(schema.properties.customLinkPreview.additionalProperties).toBe(false);
  });

  it('keeps the object-level check of a media tool', () => {
    const image = byName.find(([name]) => name === 'MessageSendImage')![1];
    expect(messageOf(image, { sessionId: 's1', chatId: '628111@c.us', url: 'ftp://host/a.png' })).toContain(
      MEDIA_URL_MESSAGE,
    );
  });

  it('turns an unknown argument into a 400 for a caller that bypasses the transport check', async () => {
    const tool = byName.find(([name]) => name === 'SessionFindAll')![1];
    const auth = {
      validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
      hasPermission: jest.fn().mockReturnValue(true),
    } as unknown as AuthService;

    await expect(invokeTool(tool, { bogus: 1 }, 'key', auth)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves a schema that is not an object as it is', () => {
    const schema = z.string();
    const tool = defineTool({
      name: 'Echo',
      description: 'd',
      inputSchema: schema,
      tier: 'read',
      handler: () => Promise.resolve(null),
    });
    expect(tool.inputSchema).toBe(schema);
  });
});
