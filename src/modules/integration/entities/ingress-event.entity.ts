import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

// The enqueue-outcome lifecycle of a persisted event, recorded AFTER the fast ack (persist-before-ack
// means the row always exists before dispatch is attempted):
//  - 'pending'    — written by recordOrSkip; dispatch not (yet) confirmed. The reconciler sweeps these.
//  - 'dispatched': the delivery settled: delivered inline, finished by its BullMQ job, or its
//                   dead letter written once the job's attempts were exhausted. A row whose job
//                   is queued stays 'pending' until then, so a job Redis loses is replayed from it.
//  - 'failed'     — terminal: the reconciler exhausted its replay budget or found the queue job failed,
//                   or the row aged past INGRESS_DEDUP_RETENTION_DAYS undispatched; recovery continues
//                   via the integration_delivery_failures row + RedriveService (none is written when the
//                   instance or session was deleted).
// NULL marks rows that predate these columns on synchronize-bootstrapped DBs (no backfill ran there);
// NULL reads as "not watched" — the reconciler never sweeps it, so an upgrade can never mass-replay
// the historical dedup log.
export type IngressDispatchState = 'pending' | 'dispatched' | 'failed';

// Persist-before-ack durable row + inbound dedup oracle. UNIQUE(pluginId, instanceId, providerDeliveryId):
// instanceId is only unique within a plugin, so pluginId must be part of the key or two plugins sharing an
// instanceId string would drop each other's deliveries as false duplicates.
//
// Storage shape: the FULL payload is carried only while the row is the sole durability handle — from
// recordOrSkip until the delivery settles ('dispatched': delivered inline, finished by its BullMQ job, or
// dead-lettered by the worker) or the reconciler dead-letters it ('failed'). While a job is queued the row
// still carries it, so a job that Redis loses is replayed from the row. Once the plugin has the payload or
// the DLQ row holds it, the row's payload is retired to NULL, leaving a slim dedup marker (~hundreds of
// bytes instead of up to 2× maxBodyBytes). payloadHash is kept permanently as the content fingerprint.
@Entity('ingress_events')
@Index('UQ_ingress_events_instance_delivery', ['pluginId', 'instanceId', 'providerDeliveryId'], { unique: true })
@Index('IDX_ingress_events_createdAt', ['createdAt'])
@Index('IDX_ingress_events_dispatchState', ['dispatchState', 'createdAt'])
export class IngressEvent {
  // Host-minted uuid (crypto.randomUUID()), NOT DB-generated — the id and the jobId (= deliveryId)
  // are decoupled on purpose. @PrimaryColumn, not @PrimaryGeneratedColumn.
  @PrimaryColumn()
  id!: string;

  @Column()
  instanceId!: string;

  @Column()
  pluginId!: string;

  @Column()
  providerDeliveryId!: string;

  @Column()
  route!: string;

  // NULL once the delivery has settled (see the storage-shape comment above). The reconciler
  // only replays 'pending' rows, which always still carry the payload. NULL on a 'pending' row is
  // unreadable history (e.g. imported without one); the reconciler's sweep query excludes it silently,
  // and it stays pending until INGRESS_DEDUP_RETENTION_DAYS prunes it.
  // `method` is the request's HTTP method, so a replay reaches the handler as the live attempt did. Rows
  // written before it was persisted lack it, and dispatch falls back to 'POST' for them.
  // `admission.verified` is what the host decided when it accepted the request (false on a route that
  // authenticates nothing, and for a query no signature covered); a replay or retry hands the handler that
  // verdict, not the route's current scheme. Rows written before it was persisted lack it, and dispatch reads
  // the route as it stands.
  @Column({ type: jsonColumnType(), nullable: true })
  payload!: {
    headers: Record<string, string>;
    query: Record<string, string>;
    body: string;
    rawBody: string;
    providerDeliveryId?: string;
    method?: string;
    admission?: { verified: boolean };
  } | null;

  // sha256 hex of the rawBody, written at recordOrSkip. Survives payload retirement so operators can
  // still correlate a dedup row with a provider delivery without storing the payload. NULL on rows
  // that predate the column (no backfill — their payloads are retired anyway).
  @Column({ type: 'varchar', nullable: true })
  payloadHash!: string | null;

  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  // Nullable by design (see the IngressDispatchState comment above): NO DB default, because the
  // default 'pending' would also stamp pre-upgrade rows on the synchronize path and the reconciler
  // would replay the whole dedup log on deploy. New rows are 'pending' via recordOrSkip explicitly;
  // migration-managed DBs backfill existing rows to 'dispatched' instead.
  @Column({ type: 'varchar', nullable: true })
  dispatchState!: IngressDispatchState | null;

  // Dispatch-attempt counter the reconciler caps its replay budget against; the live path bumps it
  // on a swallowed inline-dispatch failure so those retries count too, and the sweep bumps it for each
  // replay of a queue job that was lost.
  @Column({ type: 'int', default: 0 })
  dispatchAttempts!: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastDispatchAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
