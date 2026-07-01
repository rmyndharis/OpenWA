import { makeOnWebhookSubscribe } from './webhook-subscribe.util';

describe('onWebhookSubscribe hardening', () => {
  const declaredRoutes = new Set(['chatwoot']);

  it('registers a declared route once and dedups repeats', () => {
    const subscribed = new Set<string>();
    const on = makeOnWebhookSubscribe({
      pluginId: 'p',
      declaredRoutes,
      hasPermission: true,
      subscribed,
      maxRoutes: 8,
      warn: jest.fn(),
    });

    on('chatwoot');
    on('chatwoot');

    expect([...subscribed]).toEqual(['chatwoot']);
  });

  it('silently drops a route the manifest never declared', () => {
    const subscribed = new Set<string>();
    makeOnWebhookSubscribe({
      pluginId: 'p',
      declaredRoutes,
      hasPermission: true,
      subscribed,
      maxRoutes: 8,
      warn: jest.fn(),
    })('unknown');

    expect(subscribed.size).toBe(0);
  });

  it('warns at most once about undeclared routes so a flood is not a log-flood vector', () => {
    const subscribed = new Set<string>();
    const warn = jest.fn();
    const on = makeOnWebhookSubscribe({
      pluginId: 'p',
      declaredRoutes,
      hasPermission: true,
      subscribed,
      maxRoutes: 8,
      warn,
    });

    on('x');
    on('y');
    on('z');

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('silently drops all routes when the manifest lacks webhook:ingress', () => {
    const subscribed = new Set<string>();
    const warn = jest.fn();
    makeOnWebhookSubscribe({
      pluginId: 'p',
      declaredRoutes,
      hasPermission: false,
      subscribed,
      maxRoutes: 8,
      warn,
    })('chatwoot');

    expect(subscribed.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('size-caps the subscribed set', () => {
    const subscribed = new Set<string>();
    const routes = new Set(['a', 'b', 'c']);
    const on = makeOnWebhookSubscribe({
      pluginId: 'p',
      declaredRoutes: routes,
      hasPermission: true,
      subscribed,
      maxRoutes: 2,
      warn: jest.fn(),
    });

    on('a');
    on('b');
    on('c');

    expect(subscribed.size).toBe(2);
  });
});
