import { dispatchCapabilityVerb } from './capability-router';

it('routes handover.set to context.handover.set with (key, state)', async () => {
  const set = jest.fn().mockResolvedValue(undefined);
  const key = { sessionId: 's', chatId: 'c', instanceId: 'i' };
  await dispatchCapabilityVerb({ handover: { set } } as never, 'handover.set', [key, 'human']);
  expect(set).toHaveBeenCalledWith(key, 'human');
});
