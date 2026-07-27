import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { isUniqueViolation } from '../../common/utils/db-errors';
import type { EnqueueOutcome } from './ingress-enqueue.service';

export interface IngressEventInput {
  instanceId: string;
  pluginId: string;
  providerDeliveryId: string;
  route: string;
  payload: { headers: Record<string, string>; query: Record<string, string>; body: string; rawBody: string };
  // sha256 hex of payload.rawBody — the slim content fingerprint that survives payload retirement.
  payloadHash: string;
  sessionId: string | null;
}

// The dedup identity of a persisted event — the same key recordOrSkip's UNIQUE constraint enforces.
export interface IngressEventKey {
  pluginId: string;
  instanceId: string;
  providerDeliveryId: string;
}

@Injectable()
export class IngressEventService {
  constructor(@InjectRepository(IngressEvent, 'data') private readonly repo: Repository<IngressEvent>) {}

  // Persist-before-ack + dedup. true = newly recorded (enqueue it); false = duplicate (drop, already handled).
  // New rows are stamped 'pending' EXPLICITLY (no DB default on dispatchState) so rows that predate the
  // dispatch columns on a synchronize-bootstrapped DB stay NULL = "not watched" and an upgrade can never
  // mass-replay the historical dedup log.
  async recordOrSkip(input: IngressEventInput): Promise<boolean> {
    try {
      await this.repo.insert({ id: randomUUID(), ...input, dispatchState: 'pending' });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  /**
   * Record the enqueue outcome on the persisted event. 'queued'/'dispatched' mean the event reached
   * the dispatch tier → 'dispatched' (a later in-tier failure dead-letters via the processor/DLQ, not
   * this row) — and the full payload is retired to NULL: the dispatch tier now owns it (the BullMQ job
   * data, or the DLQ row on failure), so the dedup row slims down to its hash + metadata. 'failed'
   * (the swallowed inline-dispatch failure) bumps the attempt counter and leaves the row 'pending'
   * WITH its payload so the reconciler can still replay from it — the live path's own retry signal.
   */
  async markDispatchOutcome(key: IngressEventKey, outcome: EnqueueOutcome['outcome']): Promise<void> {
    if (outcome === 'failed') {
      await this.repo.increment(key, 'dispatchAttempts', 1);
      await this.repo.update(key, { lastDispatchAt: new Date() });
      return;
    }
    await this.repo.update(key, { dispatchState: 'dispatched', lastDispatchAt: new Date(), payload: null });
  }
}
