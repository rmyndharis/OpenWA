import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

// The enqueue-outcome lifecycle of a persisted event, recorded AFTER the fast ack (persist-before-ack
// means the row always exists before dispatch is attempted):
//  - 'pending'    — written by recordOrSkip; dispatch not (yet) confirmed. The reconciler sweeps these.
//  - 'dispatched' — the event reached the dispatch tier (handed to BullMQ or delivered inline). A
//                   failure INSIDE the tier (BullMQ attempts exhausted) dead-letters separately, so a
//                   'dispatched' row is never the reconciler's concern.
//  - 'failed'     — terminal: the reconciler exhausted its replay budget; recovery continues via the
//                   integration_delivery_failures row + RedriveService.
// NULL marks rows that predate these columns on synchronize-bootstrapped DBs (no backfill ran there);
// NULL reads as "not watched" — the reconciler never sweeps it, so an upgrade can never mass-replay
// the historical dedup log.
export type IngressDispatchState = 'pending' | 'dispatched' | 'failed';

// Persist-before-ack durable row + inbound dedup oracle. UNIQUE(pluginId, instanceId, providerDeliveryId):
// instanceId is only unique within a plugin, so pluginId must be part of the key or two plugins sharing an
// instanceId string would drop each other's deliveries as false duplicates.
@Entity('ingress_events')
@Index('UQ_ingress_events_instance_delivery', ['pluginId', 'instanceId', 'providerDeliveryId'], { unique: true })
@Index('IDX_ingress_events_createdAt', ['createdAt'])
@Index('IDX_ingress_events_dispatchState', ['dispatchState', 'createdAt'])
export class IngressEvent {
  // Host-minted uuid (crypto.randomUUID()), NOT DB-generated — the id and the jobId (= deliveryId)
  // are decoupled on purpose. @PrimaryColumn, not @PrimaryGeneratedColumn.
  @PrimaryColumn()
  id: string;

  @Column()
  instanceId: string;

  @Column()
  pluginId: string;

  @Column()
  providerDeliveryId: string;

  @Column()
  route: string;

  @Column({ type: jsonColumnType() })
  payload: { headers: Record<string, string>; query: Record<string, string>; body: string; rawBody: string };

  @Column({ type: 'varchar', nullable: true })
  sessionId: string | null;

  // Nullable by design (see the IngressDispatchState comment above): NO DB default, because the
  // default 'pending' would also stamp pre-upgrade rows on the synchronize path and the reconciler
  // would replay the whole dedup log on deploy. New rows are 'pending' via recordOrSkip explicitly;
  // migration-managed DBs backfill existing rows to 'dispatched' instead.
  @Column({ type: 'varchar', nullable: true })
  dispatchState: IngressDispatchState | null;

  // Dispatch-attempt counter the reconciler caps its replay budget against; the live path bumps it
  // on a swallowed inline-dispatch failure so those retries count too.
  @Column({ type: 'int', default: 0 })
  dispatchAttempts: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastDispatchAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
