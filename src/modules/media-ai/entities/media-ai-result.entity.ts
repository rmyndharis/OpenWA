import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('media_ai_results')
export class MediaAiResult {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  messageId: string;

  @Column()
  @Index()
  sessionId: string;

  @Column()
  mediaType: 'audio' | 'image' | 'video' | 'document';

  @Column({ nullable: true, type: 'text' })
  @Index({ fulltext: true })
  transcription?: string;

  @Column({ nullable: true, type: 'text' })
  @Index({ fulltext: true })
  ocrText?: string;

  @Column({ nullable: true, type: 'text' })
  imageDescription?: string;

  @Column({ nullable: true })
  moderationFlagged?: boolean;

  @Column({ nullable: true, type: 'text' })
  moderationCategories?: string; // JSON

  @Column({ nullable: true })
  detectedLanguage?: string;

  @Column({ nullable: true })
  processingTimeMs?: number;

  @CreateDateColumn()
  createdAt: Date;
}
