import * as fs from 'fs';
import * as path from 'path';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from './entities/session.entity';
import { baileysAuthDir, readAuthDirEntries, wwjsAuthDir } from '../../engine/auth-dir-paths';
import { isSafeSessionName } from '../../common/utils/path-safety';
import { createLogger } from '../../common/services/logger.service';

/**
 * One-time rename of the engine auth directories from the legacy `Session.name` key to `Session.id`.
 *
 * Runs in `onModuleInit`, which Nest completes for EVERY module before the first
 * `onApplicationBootstrap` hook: auto-start launches engines from that later hook and the HTTP
 * listener binds later still, so no engine can have opened a directory while this runs.
 *
 * Safety properties, in the order they matter:
 *
 * - It only ever RENAMES. A legacy directory is never deleted, so a run that fails halfway (or a
 *   second node racing this one) can lose nothing: `rename` is atomic within a filesystem, so each
 *   directory is either at its old path or its whole self at the new one, and the loser of a race
 *   gets ENOENT and logs.
 * - It is idempotent. After a successful run the legacy entry is gone, so the next boot matches
 *   nothing. A directory already at the id key is left alone.
 * - It matches the on-disk entry name EXACTLY, from a directory listing, rather than asking
 *   `fs.existsSync` whether the legacy path exists. That is what makes it safe on the
 *   case-insensitive filesystems the bug (#1597) comes from: there, `existsSync` answers yes for
 *   `session-My-Bot` when only `session-my-bot` is stored, and the rename would hand one session's
 *   WhatsApp login to another. An exact match moves each directory to the id of the row that really
 *   owns it.
 * - A missing base directory (fresh install, or an engine never used here) is a no-op.
 *
 * Keep it beyond one release: an operator can upgrade from any older version, and the directories
 * they bring are name-keyed.
 */
@Injectable()
export class SessionAuthDirMigration implements OnModuleInit {
  private readonly logger = createLogger('SessionAuthDirMigration');

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.sessionRepository.find({ select: { id: true, name: true } });
    if (rows.length === 0) return;

    // Sink guard, the same one EngineFactory keeps for the same reason: `legacy` below is derived
    // from a stored name, and a row written outside the app (a crafted archive) could carry
    // `../alice`, whose path.join + basename resolves onto another session's directory and would
    // rename that login onto this row's id. Names the API accepts can never fail this.
    const sessions = rows.filter(row => isSafeSessionName(row.name) && isSafeSessionName(row.id));
    if (sessions.length < rows.length) {
      this.logger.warn(
        `Skipped ${rows.length - sessions.length} session(s) whose name or id is not a safe auth-directory key; ` +
          'their auth directories stay where they are and those sessions start at a QR code.',
        { action: 'auth_dir_migration_unsafe_key' },
      );
    }

    const sessionDataPath = this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions';
    const authDir = this.configService.get<string>('engine.baileys.authDir') ?? './data/baileys';
    // Both engine shapes, whatever ENGINE_TYPE says: a session that ever ran under the other engine
    // still has a live auth directory there, and leaving it name-keyed would strand it (the same
    // reason EngineFactory.purgeSessionData removes both).
    const found = [
      ...this.migrateBase('whatsapp-web.js', sessions, path.resolve(sessionDataPath), key =>
        wwjsAuthDir(sessionDataPath, key),
      ),
      ...this.migrateBase('baileys', sessions, authDir, key => baileysAuthDir(authDir, key)),
    ];
    this.warnOnCaseCollisions(sessions, new Set(found));
  }

  /**
   * Rename every legacy directory under one engine's base directory, and return the names a legacy
   * directory was actually found for. The entry names come from `dirFor`, the same builder the
   * adapters use, so the per-engine shape (`session-<key>` for whatsapp-web.js, a bare `<key>` for
   * baileys) is not spelled out a second time here.
   */
  private migrateBase(engine: string, sessions: Session[], base: string, dirFor: (key: string) => string): string[] {
    let entries: Set<string>;
    try {
      entries = readAuthDirEntries(base);
    } catch (error) {
      // ENOENT is the ordinary case: a fresh install, or an engine that never stored credentials
      // here. Anything else (EACCES after the container user changed, ENOTDIR) skips EVERY session
      // on this engine, which looks exactly like an unexplained mass unlink unless it is said here.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not list the ${engine} auth directory, so no session was migrated under it`, {
          action: 'auth_dir_migration_unreadable',
          engine,
          base,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }

    const found: string[] = [];
    for (const session of sessions) {
      const legacy = path.basename(dirFor(session.name));
      const target = path.basename(dirFor(session.id));
      if (legacy === target || !entries.has(legacy)) continue;
      found.push(session.name);
      if (entries.has(target)) {
        this.logger.warn(
          `Session "${session.name}" has both a legacy and an id-keyed ${engine} auth directory; ` +
            `keeping both and using the id-keyed one. Remove "${path.join(base, legacy)}" once you have ` +
            'confirmed the session links correctly.',
          { sessionId: session.id, action: 'auth_dir_migration_conflict', engine, legacy, target },
        );
        continue;
      }
      try {
        fs.renameSync(path.join(base, legacy), path.join(base, target));
        entries.delete(legacy);
        entries.add(target);
        this.logger.log(`Moved the ${engine} auth directory of session "${session.name}" onto its session id`, {
          sessionId: session.id,
          action: 'auth_dir_migrated',
          engine,
          legacy,
          target,
        });
      } catch (error) {
        this.logger.warn(`Could not move the ${engine} auth directory of session "${session.name}"`, {
          sessionId: session.id,
          action: 'auth_dir_migration_failed',
          engine,
          legacy,
          target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return found;
  }

  /**
   * Names that differ only in case are distinct rows but were ONE directory on a case-insensitive
   * filesystem, so at most one of them can carry the stored login forward: the rename above matches
   * the on-disk entry exactly, so the row whose name is the stored one keeps it and the others come
   * back at a QR. Say so at boot, or that re-pairing looks like an unexplained unlink.
   *
   * Only for a group the walk really found a legacy directory for (`legacyNames`): names cannot be
   * renamed, so warning on the names alone would repeat at every boot forever, and it would be
   * untrue on a case-sensitive filesystem and on names created after the upgrade, where each row has
   * always had a directory of its own.
   */
  private warnOnCaseCollisions(sessions: Session[], legacyNames: Set<string>): void {
    const byFoldedName = new Map<string, string[]>();
    for (const session of sessions) {
      const folded = session.name.toLowerCase();
      byFoldedName.set(folded, [...(byFoldedName.get(folded) ?? []), session.name]);
    }
    for (const names of byFoldedName.values()) {
      if (names.length < 2 || !names.some(name => legacyNames.has(name))) continue;
      this.logger.warn(
        `Sessions ${names.map(name => `"${name}"`).join(', ')} have names that differ only in letter case. ` +
          'On a case-insensitive filesystem they shared one engine auth directory, so only one keeps its ' +
          'stored WhatsApp login; the others come back with a QR to scan.',
        { action: 'auth_dir_case_collision', names },
      );
    }
  }
}
