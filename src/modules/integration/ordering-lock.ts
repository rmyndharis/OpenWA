import { IngressJobData } from '../queue/processors/ingress.processor';

// Single-node, in-process keyed lock: a chain of promises per key. The ordering key is a plain
// string (no closures) so a distributed lock (e.g. Redis redlock / SET NX PX) can replace this
// verbatim once ingress runs on more than one node.
export class KeyedAsyncLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Chain fn after prev; swallow prev's rejection so one failure doesn't poison the chain.
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    // Clean up the map entry once this is the tail and it settles, to avoid unbounded growth.
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    return next;
  }
}

// Key on the CONVERSATION, never the deliveryId (a delivery-unique key would serialize nothing).
// providerConversationId is populated host-side when the plugin manifest declares a conversationId
// pointer; absent it, we serialize per instance — correct (never reorders within a conversation) but
// coarse. Per-instance fallback is the lazy-correct default; the conversation key unlocks
// intra-instance parallelism once the manifest declares the pointer.
export function orderingKeyFor(job: IngressJobData): string {
  if (job.providerConversationId) return `${job.instanceId}:${job.providerConversationId}`;
  return `instance:${job.instanceId}`;
}
