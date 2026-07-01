/**
 * Pure guard logic for a sandboxed worker's `webhook-subscribe` messages, mirroring the loader's
 * onHookSubscribe hardening. The IPC boundary is untrusted: a hostile/buggy worker can post
 * `webhook-subscribe` with an undeclared route, the same route repeatedly, or a flood of fabricated
 * routes. Without guards each call records a live host-side ingress registration (unbounded growth).
 *
 * Three guards, all keyed off the manifest (which the operator authored, not the worker): drop when
 * the manifest lacks `webhook:ingress` (silent — the plugin has no ingress at all), drop an
 * undeclared route (warn at most once so a flood isn't a log-flood vector), dedup, and a size cap.
 */
export interface OnWebhookSubscribeDeps {
  pluginId: string;
  declaredRoutes: Set<string>; // routes from manifest.ingress[].route
  hasPermission: boolean; // manifest declares webhook:ingress
  subscribed: Set<string>;
  maxRoutes: number;
  warn: (message: string, meta: Record<string, unknown>) => void;
}

export function makeOnWebhookSubscribe(deps: OnWebhookSubscribeDeps): (route: string) => void {
  let unknownRouteWarned = false;
  return (route: string): void => {
    if (!deps.hasPermission) return; // no ingress permission => the plugin claims no routes at all
    if (!deps.declaredRoutes.has(route)) {
      if (!unknownRouteWarned) {
        unknownRouteWarned = true; // warn at most once per plugin so a flood isn't a log-flood vector
        deps.warn(`Sandboxed plugin ${deps.pluginId} subscribed to an undeclared ingress route; ignoring`, {
          pluginId: deps.pluginId,
          route,
          action: 'sandbox_unknown_ingress_route',
        });
      }
      return;
    }
    if (deps.subscribed.has(route)) return;
    if (deps.subscribed.size >= deps.maxRoutes) return; // belt-and-suspenders cap
    deps.subscribed.add(route);
  };
}
