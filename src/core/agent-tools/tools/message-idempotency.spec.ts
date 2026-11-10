import { BadRequestException, NotImplementedException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { invokeTool } from '../tool-invoker';
import { messageTools } from './message.tools';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { AuthService } from '../../../modules/auth/auth.service';
import type { MessageService } from '../../../modules/message/message.service';
import {
  hashSendRequest,
  type SendIdempotencyService,
} from '../../../modules/message/idempotency/send-idempotency.service';

// The tools whose REST routes take an `Idempotency-Key` header (send-poll has no tool). MessageReact is left out:
// setting the same reaction twice is already harmless.
const SEND_TOOLS = [
  'MessageSendText',
  'MessageSendImage',
  'MessageSendVideo',
  'MessageSendAudio',
  'MessageSendDocument',
  'MessageSendLocation',
  'MessageSendContact',
  'MessageSendSticker',
  'MessageSendTemplate',
  'MessageReply',
  'MessageForward',
];

function makeStore() {
  const claim = jest.fn().mockResolvedValue({ kind: 'claimed', id: 'row-1' });
  const complete = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn().mockResolvedValue(undefined);
  const markFailed = jest.fn().mockResolvedValue(undefined);
  return {
    claim,
    complete,
    release,
    markFailed,
    store: { claim, complete, release, markFailed } as unknown as SendIdempotencyService,
  };
}

function makeAuth(): Pick<AuthService, 'validateApiKey' | 'hasPermission'> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
    hasPermission: jest.fn().mockReturnValue(true),
  };
}

const find = (name: string, message: Partial<MessageService>, store?: SendIdempotencyService): AnyToolDescriptor =>
  messageTools(message as MessageService, store).find(t => t.name === name)!;
const run = (tool: AnyToolDescriptor, input: unknown) =>
  invokeTool(tool, input, 'key', makeAuth() as unknown as AuthService);

describe('idempotencyKey on the send tools', () => {
  it('is published, optional and pattern-bound on exactly the send tools', () => {
    const withKey: string[] = [];
    for (const tool of messageTools({} as MessageService)) {
      const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as {
        properties: Record<string, { type?: string; maxLength?: number; pattern?: string }>;
        required?: string[];
      };
      if (!('idempotencyKey' in schema.properties)) continue;
      withKey.push(tool.name);
      expect(schema.properties.idempotencyKey).toMatchObject({ type: 'string', maxLength: 255 });
      expect(schema.properties.idempotencyKey.pattern).toBeDefined();
      expect(schema.required ?? []).not.toContain('idempotencyKey');
    }
    expect(withKey.sort()).toEqual([...SEND_TOOLS].sort());
  });

  it.each(SEND_TOOLS)('%s claims the key under its own route and answers a replay without sending', async name => {
    const { claim, store } = makeStore();
    claim.mockResolvedValue({ kind: 'replay', body: { messageId: 'first' } });
    // An empty service: reaching the send itself would be a TypeError, not the stored answer.
    const tool = find(name, {}, store);

    await expect(
      tool.handler({ sessionId: 's1', idempotencyKey: 'k1' } as never, { id: 'k1' } as never),
    ).resolves.toEqual({ messageId: 'first' });

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', key: 'k1', route: `mcp:${name}` }));
  });

  it.each(SEND_TOOLS)('%s refuses a key it cannot honor instead of sending unclaimed', async name => {
    const tool = find(name, {});

    await expect(
      tool.handler({ sessionId: 's1', idempotencyKey: 'k1' } as never, { id: 'k1' } as never),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('claims the arguments without the key, runs the send once without the key, and stores its answer', async () => {
    const { claim, complete, store } = makeStore();
    const sendText = jest.fn().mockResolvedValue({ messageId: 'm1' });
    const input = { sessionId: 's1', chatId: '628111@c.us', text: 'hi' };

    await expect(
      run(find('MessageSendText', { sendText }, store), { ...input, idempotencyKey: 'order-42' }),
    ).resolves.toEqual({
      messageId: 'm1',
    });

    expect(claim).toHaveBeenCalledWith({
      sessionId: 's1',
      key: 'order-42',
      route: 'mcp:MessageSendText',
      requestHash: hashSendRequest('mcp:MessageSendText', input),
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as [string, object])[1]).not.toHaveProperty('idempotencyKey');
    expect(complete).toHaveBeenCalledWith('row-1', { messageId: 'm1' });
  });

  it('does not send again for the same key and arguments', async () => {
    const { claim, store } = makeStore();
    const sendText = jest.fn().mockResolvedValue({ messageId: 'm1' });
    const input = { sessionId: 's1', chatId: '628111@c.us', text: 'hi', idempotencyKey: 'order-42' };
    claim
      .mockResolvedValueOnce({ kind: 'claimed', id: 'row-1' })
      .mockResolvedValueOnce({ kind: 'replay', body: { messageId: 'm1' } });
    const tool = find('MessageSendText', { sendText }, store);

    await run(tool, input);
    await expect(run(tool, input)).resolves.toEqual({ messageId: 'm1' });

    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('touches no storage without a key', async () => {
    const { claim, store } = makeStore();
    const sendText = jest.fn().mockResolvedValue({ messageId: 'm1' });

    await run(find('MessageSendText', { sendText }, store), { sessionId: 's1', chatId: '628111@c.us', text: 'hi' });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it.each(['', 'has space', 'x'.repeat(256), 'tab\there', 'é'])(
    'refuses the key %j before anything runs',
    async key => {
      const { claim, store } = makeStore();
      const sendText = jest.fn();

      await expect(
        run(find('MessageSendText', { sendText }, store), {
          sessionId: 's1',
          chatId: '628111@c.us',
          text: 'hi',
          idempotencyKey: key,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(claim).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it('frees the key when the send is refused, and passes the refusal on', async () => {
    const { release, markFailed, store } = makeStore();
    const refusal = new BadRequestException('Session is not started');
    const sendText = jest.fn().mockRejectedValue(refusal);

    await expect(
      run(find('MessageSendText', { sendText }, store), {
        sessionId: 's1',
        chatId: '628111@c.us',
        text: 'hi',
        idempotencyKey: 'k1',
      }),
    ).rejects.toBe(refusal);

    expect(release).toHaveBeenCalledWith('row-1');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('refuses a key already bound to other arguments', async () => {
    const { claim, store } = makeStore();
    claim.mockResolvedValue({ kind: 'mismatch' });
    const sendText = jest.fn();

    await expect(
      run(find('MessageSendText', { sendText }, store), {
        sessionId: 's1',
        chatId: '628111@c.us',
        text: 'other',
        idempotencyKey: 'k1',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(sendText).not.toHaveBeenCalled();
  });
});
