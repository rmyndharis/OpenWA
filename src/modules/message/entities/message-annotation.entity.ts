import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';

export type MessageAnnotationKind = 'transcript';
export type MessageAnnotationStatus = 'pending' | 'complete' | 'failed' | 'expired';
export type MessageAnnotationMetadataValue = string | number | boolean | null;
export type MessageAnnotationMetadata = Record<string, MessageAnnotationMetadataValue>;

/** Provider-produced derived content kept beside, never inside, the raw message payload. */
@Entity('message_annotations')
@Index('IDX_message_annotations_session_message', ['sessionId', 'messageId'])
export class MessageAnnotation {
  @PrimaryColumn({ type: 'varchar' })
  sessionId: string;

  @PrimaryColumn({ type: 'varchar' })
  messageId: string;

  @PrimaryColumn({ type: 'varchar', length: 128 })
  provider: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  kind: MessageAnnotationKind;

  @Column({ type: 'varchar', length: 32 })
  status: MessageAnnotationStatus;

  @Column({ type: 'varchar', length: 35, nullable: true })
  language: string | null;

  /** Sensitive derived text. It is intentionally absent from Message and webhook projections. */
  @Column({ type: 'text', nullable: true })
  text: string | null;

  /** SHA-256 fingerprint only; never a media URL, path, or bytes. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  mediaFingerprint: string | null;

  @Column({ type: 'varchar', length: 128 })
  processorVersion: string;

  @Column({ type: 'boolean' })
  externalProcessing: boolean;

  /** Small scalar-only provider facts, bounded and validated by MessageAnnotationService. */
  @Column({ type: jsonColumnType(), nullable: true })
  metadata: MessageAnnotationMetadata | null;

  // Bare, like every other @CreateDateColumn in the project (session/webhook/message-batch). Pairing
  // a generated create-date with dateColumnType()+DateTransformer resolves to `text` on SQLite, which
  // TypeORM does not treat as a date type — it then writes NULL and every insert trips the column's
  // NOT NULL constraint.
  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  expiresAt: Date | null;
}
