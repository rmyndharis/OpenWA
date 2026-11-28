/**
 * The Redis key of the hold the node that queued a job writes while it keeps a change of the job's message: a lease
 * Redis expires itself, so a worker of another node never reads one node's clock against another's.
 */
export const jobHoldKey = (queue: { toKey(type: string): string }, deliveryId: string): string =>
  queue.toKey(`held:${deliveryId}`);
