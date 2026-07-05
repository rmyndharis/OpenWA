import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

// One configured instance of an adapter plugin (e.g. one Chatwoot account). instanceId is namespaced
// under pluginId; NOT a separate worker. Secret is host-minted and masked-on-read.
@Entity('plugin_instances')
@Index('UQ_plugin_instances_plugin_instance', ['pluginId', 'instanceId'], { unique: true })
export class PluginInstance {
  @PrimaryColumn()
  id: string; // `${pluginId}:${instanceId}`

  @Column()
  pluginId: string;

  @Column()
  instanceId: string;

  @Column({ type: 'varchar', nullable: true })
  sessionScope: string | null; // resolved session id this instance acts on; null = inherit manifest.sessions

  @Column()
  secret: string; // host-minted ingress HMAC secret; stored plaintext, masked to '***' on API reads
  // (via PluginInstanceService.maskedView + the provisioning controller's reveal flag), exposed
  // in full only on mint and regenerate-secret. Note: instance `config` is NOT secret-redacted.

  @Column({ type: 'varchar', nullable: true })
  verifyToken: string | null; // optional provider challenge token

  @Column({ type: jsonColumnType(), nullable: true })
  config: Record<string, unknown> | null;

  @Column({ default: true })
  enabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
