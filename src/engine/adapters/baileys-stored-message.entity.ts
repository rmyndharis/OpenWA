import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Session } from '../../modules/session/entities/session.entity';

/**
 * Persisted Baileys message store (the lib ships none). Holds the serialized WAMessage proto
 * (via BufferJSON) so reply/forward/react/delete can resolve the original message/key by id across
 * restarts. Engine-specific — lives in the engine layer, not the neutral `messages` table.
 *
 * The `session` relation declares the CASCADE FK so both the `synchronize:true` SQLite path and
 * the migration path clean up stored messages when the parent session row is deleted.
 */
@Entity('baileys_stored_messages')
@Index(['sessionId', 'waMessageId'], { unique: true }) // lookup + dedup (send-return vs upsert echo)
@Index(['sessionId', 'createdAt']) // eviction ordering
export class BaileysStoredMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sessionId: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session?: Session;

  @Column()
  waMessageId: string;

  @Column({ type: 'text' })
  serializedMessage: string;

  @CreateDateColumn()
  createdAt: Date;
}
