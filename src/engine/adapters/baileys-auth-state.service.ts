import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BaileysAuthState } from './baileys-auth-state.entity';
import { BaileysAuthStateStore } from '../types/baileys.types';
import { createLogger } from '../../common/services/logger.service';

/**
 * Database-backed {@link BaileysAuthStateStore} on the `data` connection — the portable alternative
 * to `useMultiFileAuthState`'s local directory. Deliberately a dumb string K/V (see the interface):
 * values arrive already serialized, so this service compiles without the Baileys library and the
 * table stays engine-version-agnostic.
 */
@Injectable()
export class BaileysAuthStateService implements BaileysAuthStateStore {
  private readonly logger = createLogger('BaileysAuthStateService');

  constructor(
    @InjectRepository(BaileysAuthState, 'data')
    private readonly repository: Repository<BaileysAuthState>,
  ) {}

  async read(sessionName: string, keyType: string, keyIds: string[]): Promise<Record<string, string>> {
    if (keyIds.length === 0) return {};
    const rows = await this.repository.find({
      where: { sessionName, keyType, keyId: In(keyIds) },
      select: { keyId: true, value: true },
    });
    return Object.fromEntries(rows.map(row => [row.keyId, row.value]));
  }

  async write(
    sessionName: string,
    entries: Array<{ keyType: string; keyId: string; value: string | null }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const deletions = entries.filter(entry => entry.value === null);
    const upserts = entries.filter((entry): entry is { keyType: string; keyId: string; value: string } => {
      return entry.value !== null;
    });
    // One transaction per batch: a signal-key set that half-lands leaves the session in a state
    // Baileys never wrote, which is exactly the corruption the multi-file backend cannot get either
    // (it writes whole files). ON CONFLICT upsert keeps a re-delivered write idempotent.
    await this.repository.manager.transaction(async manager => {
      if (upserts.length > 0) {
        await manager.upsert(
          BaileysAuthState,
          upserts.map(entry => ({ sessionName, keyType: entry.keyType, keyId: entry.keyId, value: entry.value })),
          { conflictPaths: ['sessionName', 'keyType', 'keyId'] },
        );
      }
      for (const entry of deletions) {
        await manager.delete(BaileysAuthState, { sessionName, keyType: entry.keyType, keyId: entry.keyId });
      }
    });
  }

  async hasCreds(sessionName: string): Promise<boolean> {
    const count = await this.repository.count({ where: { sessionName, keyType: 'creds', keyId: 'creds' } });
    return count > 0;
  }

  async clear(sessionName: string): Promise<void> {
    const result = await this.repository.delete({ sessionName });
    if (result.affected && result.affected > 0) {
      this.logger.log(`Cleared ${result.affected} stored auth-state value(s)`, { sessionName });
    }
  }
}
