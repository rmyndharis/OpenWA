import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One Baileys auth-state value — the credentials blob or one Signal key — for one session, keyed by
 * session NAME (the same key the on-disk auth directory uses, so the two backends describe the same
 * session identically and a disk→database import is a pure copy).
 *
 * This table is what makes a Baileys session portable across nodes: with `BAILEYS_AUTH_STORE=database`
 * the multi-file directory is no longer the session's home, so any worker sharing the data DB can
 * start the session without local state following it around.
 *
 * `value` is the BufferJSON-serialized JSON string exactly as the multi-file backend would have
 * written it to disk — serialization stays in `useDatabaseAuthState`, never here.
 */
@Entity('baileys_auth_state')
export class BaileysAuthState {
  @PrimaryColumn({ type: 'varchar' })
  sessionName!: string;

  /** 'creds' for the credentials blob; otherwise the Signal key type ('pre-key', 'session', ...). */
  @PrimaryColumn({ type: 'varchar' })
  keyType!: string;

  /** 'creds' for the credentials blob; otherwise the sanitized Signal key id. */
  @PrimaryColumn({ type: 'varchar' })
  keyId!: string;

  @Column({ type: 'text' })
  value!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
