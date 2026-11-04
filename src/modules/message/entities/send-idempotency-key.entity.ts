import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * The lifecycle of one `Idempotency-Key` claim on a send route:
 *  - 'pending'   - the request holding the key is running (or the node died while it ran).
 *  - 'completed' - the send succeeded; `responseBody` is replayed to every retry with the same key.
 *  - 'failed'    - the send failed in a way that does not say whether WhatsApp got the message (an
 *                  engine error or timeout). The key stays taken so a retry cannot send it twice.
 * A refusal before the engine call deletes the row, so the client may retry with the same key.
 * Engine-stage failures keep it taken whatever their HTTP status, including a disconnected socket's 409,
 * unless the engine proves that nothing was sent (see sendFailureProvesNothingSent), which deletes it too.
 */
export type SendIdempotencyState = 'pending' | 'completed' | 'failed';

/**
 * One `Idempotency-Key` a client sent on a send route, kept for SEND_IDEMPOTENCY_TTL (24 h) so a
 * retry after a timeout or a dropped connection replays the first answer instead of sending the
 * message again. Opt-in per request: a send without the header never touches this table.
 *
 * UNIQUE(sessionId, idempotencyKey) is the claim: the insert that wins it runs the send, every other
 * request with the pair reads the row. It holds across nodes sharing one database, because the claim
 * is the insert itself rather than a read followed by a write.
 *
 * Lives on the `data` connection (auto-loaded by the message entity glob). Not exported by
 * `GET /infra/export-data`: a key outlives its purpose within a day.
 */
@Entity('send_idempotency_keys')
@Index('UQ_send_idempotency_keys_session_key', ['sessionId', 'idempotencyKey'], { unique: true })
@Index('IDX_send_idempotency_keys_expiresAt', ['expiresAt'])
export class SendIdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  sessionId!: string;

  /** The client's `Idempotency-Key` header value, verbatim (1-255 visible ASCII characters). */
  @Column()
  idempotencyKey!: string;

  /** The send route the key was first used on (`send-text`, `reply`, ...). */
  @Column()
  route!: string;

  /** SHA-256 of the route and the request body; a retry whose hash differs is refused with 422. */
  @Column()
  requestHash!: string;

  @Column({ type: 'varchar' })
  state!: SendIdempotencyState;

  /** The response body of a completed send, replayed verbatim. NULL while pending or after a failure. */
  @Column({ type: jsonColumnType(), nullable: true })
  responseBody!: Record<string, unknown> | null;

  /** When the key may be reused for a new send; the hourly sweep deletes rows past it. */
  @Column({ type: dateColumnType(), transformer: DateTransformer })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
