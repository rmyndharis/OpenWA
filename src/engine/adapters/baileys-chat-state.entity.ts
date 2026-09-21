import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Persisted per-session chat app-state (mute / archive / pin) on the `data` connection. Baileys cannot
 * re-deliver these on a reconnect: history sync is skipped once paired and `resyncAppState` only ships
 * mutations newer than the persisted version, so an already-applied mute is never re-emitted, and the
 * library keeps no queryable copy (only LTHash MACs). Measured live: after a reconnect, 0 of the synced
 * chats carried `muteEndTime`. So the value is persisted here and rehydrated on boot; live `chats.update`
 * events (including an unmute, which arrives as `muteEndTime = null`) keep it current.
 *
 * One row per (session, chat). `sessionId` is `Session.id`, the key used elsewhere in the engine
 * surface, provenance rather than a foreign key, so the row can outlive a single run. `muteEndTime` is stored as
 * canonical epoch MILLISECONDS (or null when unmuted); the numeric transformer keeps it a JS number
 * rather than the string a bigint column otherwise reads back as.
 */
@Entity('chat_states')
export class ChatState {
  /** `Session.id` of the session that owns this chat state. */
  @PrimaryColumn()
  sessionId!: string;

  /** Chat id in the engine's stored (raw Baileys) dialect, the same key `upsertChats` uses. */
  @PrimaryColumn()
  chatId!: string;

  /** Epoch MILLISECONDS the mute ends, or null when the chat is not muted. */
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: { to: (v: number | null) => v, from: (v: string | null) => (v == null ? null : Number(v)) },
  })
  muteEndTime!: number | null;

  @Column({ type: 'boolean', default: false })
  archived!: boolean;

  @Column({ type: 'boolean', default: false })
  pinned!: boolean;

  @UpdateDateColumn()
  updatedAt!: Date;
}
