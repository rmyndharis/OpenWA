import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { bigintToNumberTransformer } from '../../message/entities/message.entity';

@Entity('status_updates')
@Index(['sessionId', 'contactJid'])
@Index(['sessionId', 'waStatusId'], { unique: true })
export class StatusUpdate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  sessionId!: string;

  /** Neutral @c.us / @lid JID of the contact who posted. */
  @Column()
  contactJid!: string;

  @Column({ nullable: true })
  contactName?: string;

  @Column({ nullable: true })
  contactPushName?: string;

  /** Engine status id, e.g. false_status@broadcast_<hash>. */
  @Column()
  waStatusId!: string;

  @Column()
  type!: 'text' | 'image' | 'video' | 'voice';

  @Column({ type: 'text', nullable: true })
  caption?: string;

  /** Relative path under the media store; null for text or omitted media. */
  @Column({ nullable: true })
  mediaPath?: string;

  @Column({ nullable: true })
  mediaMimetype?: string;

  @Column({ default: false })
  mediaOmitted!: boolean;

  /** 'over_cap' | 'engine_omitted' | 'write_failed' — null when media is present or type is text. */
  @Column({ nullable: true })
  omitReason?: string;

  @Column({ nullable: true })
  backgroundColor?: string;

  @Column({ type: 'int', nullable: true })
  font?: number;

  @Column({ type: 'bigint', transformer: bigintToNumberTransformer })
  postedAt!: number; // epoch ms

  @Column({ type: 'bigint', transformer: bigintToNumberTransformer })
  @Index()
  expiresAt!: number; // epoch ms
}
