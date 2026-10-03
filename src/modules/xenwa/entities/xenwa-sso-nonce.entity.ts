import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/** A burned SSO token nonce. Kept until shortly after the token would have expired. */
@Entity('xenwa_sso_nonces')
export class XenwaSsoNonce {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  nonce!: string;

  @Index('IDX_xenwa_sso_nonces_expiresAt')
  @Column({ type: 'datetime' })
  expiresAt!: Date;
}
