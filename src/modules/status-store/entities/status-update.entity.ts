import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { bigintToNumberTransformer } from '../../message/entities/message.entity';
import { NulFreeTransformer } from '../../../common/transformers/nul-free.transformer';

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

  @Column({ nullable: true, transformer: NulFreeTransformer })
  contactName?: string;

  @Column({ nullable: true, transformer: NulFreeTransformer })
  contactPushName?: string;

  /** Engine status id, e.g. false_status@broadcast_<hash>. */
  @Column()
  waStatusId!: string;

  @Column()
  type!: 'text' | 'image' | 'video' | 'voice';

  @Column({ type: 'text', nullable: true, transformer: NulFreeTransformer })
  caption?: string;

  /**
   * Relative path under the media store; null for text or omitted media. The partial index serves the orphan
   * sweep's per-chunk `mediaPath IN (...)` lookup; the name matches the migration that creates it, and the
   * column is quoted in the predicate for the reason given on `Message.mediaPath`.
   */
  @Index('IDX_status_updates_mediaPath', { where: '"mediaPath" IS NOT NULL' })
  @Column({ nullable: true })
  mediaPath?: string;

  @Column({ nullable: true, transformer: NulFreeTransformer })
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
