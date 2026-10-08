import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';
import { NulFreeTransformer } from '../../../common/transformers/nul-free.transformer';

// DLQ-of-record for failed inbound (ingress) deliveries; only the ingress path writes it and redrive
// replays only 'inbound' rows. 'outbound' is reserved: nothing writes it. Generalizes
// webhook_delivery_failures. sessionId is provenance (no FK).
@Entity('integration_delivery_failures')
@Index('IDX_integration_delivery_failures_instance', ['pluginId', 'instanceId'])
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

  @CreateDateColumn()
  createdAt!: Date;
}
