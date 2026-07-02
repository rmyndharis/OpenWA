import { HostToWorkerMessage, WorkerToHostMessage } from './protocol';
import { hookConfigStore } from './worker-hooks';

/**
 * The verified inbound webhook a sandboxed plugin's handler sees. Mirrors the `webhook` wire message
 * minus the correlation `id` and `route` (the registry routes on `route` before invoking the handler).
 */
export interface WebhookRequest {
  instanceId: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string;
  rawBody: string;
  verified: boolean;
  deliveryId: string;
  sessionId?: string;
}

export type WebhookResponse = { status?: number; headers?: Record<string, string>; body?: string };
export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResponse | void> | WebhookResponse | void;

/**
 * Worker-side webhook handling, mirroring WorkerHookRegistry. A sandboxed plugin registers one
 * handler per ingress route (via ctx.registerWebhook). The registry subscribes the host to the route
 * the first time it sees a handler for it, and on a `webhook` message runs the handler and replies
 * with `webhook-result` — a thrown handler becomes a 500 error result, an unknown route a 404.
 */
export class WebhookRegistry {
  private readonly handlers = new Map<string, WebhookHandler>();

  constructor(private readonly post: (message: WorkerToHostMessage) => void) {}

  register(route: string, handler: WebhookHandler): void {
    this.handlers.set(route, handler);
    this.post({ kind: 'webhook-subscribe', route });
  }

  async handleWebhook(message: Extract<HostToWorkerMessage, { kind: 'webhook' }>): Promise<void> {
    const handler = this.handlers.get(message.route);
    if (!handler) {
      this.post({ kind: 'webhook-result', id: message.id, status: 404, error: 'no handler for route' });
      return;
    }
    // Run inside the per-instance config scope so ctx.config resolves to this delivery's instance config
    // (mirrors WorkerHookRegistry.handleHook). Absent config => the bootstrap getter falls back to base.
    const run = async () => {
      try {
        const result = await handler({
          instanceId: message.instanceId,
          method: message.method,
          headers: message.headers,
          query: message.query,
          body: message.body,
          rawBody: message.rawBody,
          verified: message.verified,
          deliveryId: message.deliveryId,
          sessionId: message.sessionId,
        });
        this.post({
          kind: 'webhook-result',
          id: message.id,
          status: result?.status ?? 200,
          headers: result?.headers,
          body: result?.body,
        });
      } catch (err) {
        this.post({
          kind: 'webhook-result',
          id: message.id,
          status: 500,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    if (message.config !== undefined) await hookConfigStore.run({ config: message.config }, run);
    else await run();
  }
}
