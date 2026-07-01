import { dispatchCapabilityVerb } from './capability-router';

describe('dispatchCapabilityVerb conversation.send', () => {
  it('routes conversation.send to context.conversations.send with the envelope POJO', async () => {
    const env = { type: 'text', text: 'hi', source: { provider: 'chatwoot', externalConversationId: '42' } };
    const send = jest.fn().mockResolvedValue({ id: 'm1' });
    const context = { conversations: { send } } as never;
    const result = await dispatchCapabilityVerb(context, 'conversation.send', [env]);
    expect(send).toHaveBeenCalledWith(env);
    expect(result).toEqual({ id: 'm1' });
  });
});
