import { incrementWebhookDeliveryFailures, getWebhookDeliveryFailuresTotal } from './webhook-delivery-metrics';

describe('webhook-delivery-metrics', () => {
  it('monotonically increments the terminal-failure total', () => {
    const before = getWebhookDeliveryFailuresTotal();
    incrementWebhookDeliveryFailures();
    incrementWebhookDeliveryFailures();
    expect(getWebhookDeliveryFailuresTotal()).toBe(before + 2);
  });

  it('never decreases', () => {
    const a = getWebhookDeliveryFailuresTotal();
    incrementWebhookDeliveryFailures();
    const b = getWebhookDeliveryFailuresTotal();
    expect(b).toBeGreaterThan(a);
  });
});
