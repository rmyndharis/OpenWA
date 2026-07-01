import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

// Persist-before-ack durable row + inbound dedup oracle. UNIQUE(instanceId, providerDeliveryId).
@Entity('ingress_events')
@Index('UQ_ingress_events_instance_delivery', ['instanceId', 'providerDeliveryId'], { unique: true })
@Index('IDX_ingress_events_createdAt', ['createdAt'])
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

  @CreateDateColumn()
  createdAt: Date;
}
