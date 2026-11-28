import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { NulFreeTransformer } from '../../../common/transformers/nul-free.transformer';

// DLQ-of-record for failed inbound (ingress) deliveries; only the ingress path writes it and redrive
// replays only 'inbound' rows. 'outbound' is reserved: nothing writes it. Generalizes
// webhook_delivery_failures. sessionId is provenance (no FK).
@Entity('integration_delivery_failures')
@Index('IDX_integration_delivery_failures_instance', ['pluginId', 'instanceId'])
// The per-delivery guards (open dead-letter count, tie-break, retire) filter on deliveryId as well.
@Index('IDX_integration_delivery_failures_instance_delivery', ['pluginId', 'instanceId', 'deliveryId'])
@Index('IDX_integration_delivery_failures_createdAt', ['createdAt'])
@Index('IDX_integration_delivery_failures_sessionId', ['sessionId'])
@Index('IDX_integration_delivery_failures_redrive', ['pluginId', 'instanceId', 'redriven', 'attempts', 'createdAt'])
export class IntegrationDeliveryFailure {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  direction!: 'inbound' | 'outbound';

  @Column()
  pluginId!: string;

  @Column()
  instanceId!: string;

  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  deliveryId!: string | null;

  @Column({ type: 'int' })
  attempts!: number;

  @Column({ type: 'text', transformer: NulFreeTransformer })
  lastError!: string;

  @Column({ type: jsonColumnType(), nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ default: false })
  redriven!: boolean;

  // When a redrive took the row for its dispatch, until it retires the row or puts it back. Another redrive leaves the
  // row alone meanwhile, and takes it again once this is five minutes old (RedriveService).
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  claimedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
