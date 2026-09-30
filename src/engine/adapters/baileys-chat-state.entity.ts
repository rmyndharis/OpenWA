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

  /**
   * Chat id in the raw Baileys dialect, one row per conversation: `<phone>@s.whatsapp.net` for a person
   * (also when WhatsApp synced the state under their lid, once the lid resolves), `<lid>@lid` while it
   * does not, and a group's own id. A row filed under a lid twin is folded onto the phone JID on the
   * chat's next change.
   */
  @PrimaryColumn()
  chatId!: string;

  /** Epoch MILLISECONDS the mute ends, -1 for a mute with no end ("Always"), or null when not muted. */
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

  /**
   * The state fields this row has observed, comma-separated (`muteEndTime`, `archived`, `pinned`); the
   * others hold their default only because the row was created by a patch that did not carry them.
   * Null on a row written before this column existed, read as having observed its set fields. Lets two
   * rows of one chat merge field by field without mistaking an explicit unpin, unarchive or unmute for
   * "not seen".
   */
  @Column({ type: 'varchar', nullable: true })
  observed!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
