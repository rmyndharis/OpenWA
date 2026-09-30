import { chmodSync, existsSync } from 'fs';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { createLogger } from '../common/services/logger.service';
import { ConfigService } from '@nestjs/config';

// better-sqlite3 creates its database files with 0666 & umask (0644 under the usual 022), so the
// SQLite files end up group/world-readable while every sibling secret in data/ was tightened to
// 0600/0700. That matters because these files ARE secret stores: openwa.sqlite holds the webhook
// and plugin-instance HMAC secrets and session proxy URLs in plaintext. The container deployment is
// insulated (named volume, non-root user), but bare-metal and bind-mount hosts get world-readable
// secrets. Tighten on every boot, the same re-tighten-on-start posture the credential dirs use, so
// a file recreated by a restore or a copy also converges back.
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/**
 * chmod each database file (plus its WAL/rollback sidecars) to owner-only, best-effort: a failure is
 * logged and skipped, never allowed to fail the boot. Returns the paths actually tightened.
 */
export function tightenSqliteFilePermissions(paths: string[], warn: (message: string) => void): string[] {
  const tightened: string[] = [];
  for (const path of paths) {
    for (const candidate of [path, ...SIDECAR_SUFFIXES.map(suffix => `${path}${suffix}`)]) {
      if (!existsSync(candidate)) continue;
      try {
        chmodSync(candidate, 0o600);
        tightened.push(candidate);
      } catch (error) {
        warn(
          `Could not tighten ${candidate} to owner-only permissions: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return tightened;
}

/**
 * Applies the tightening to the two bundled SQLite databases once every DataSource has initialized.
 * The DataSources initialize eagerly inside their provider factories (before any lifecycle hook
 * runs), and Nest runs every onModuleInit before any onApplicationBootstrap, so both files exist by
 * the time this hook fires. The main connection is always SQLite; the data connection mirrors the
 * app.module factory's own branch (everything except postgres is the sqlite path; env.validation
 * confines DATABASE_TYPE to those two).
 */
@Injectable()
export class SqlitePermissionsBoot implements OnApplicationBootstrap {
  private readonly logger = createLogger('SqlitePermissions');

  constructor(private readonly config: ConfigService) {}

  onApplicationBootstrap(): void {
    const paths: string[] = [this.config.get<string>('database.database', './data/main.sqlite')];
    if (this.config.get<string>('dataDatabase.type', 'sqlite') !== 'postgres') {
      paths.push(this.config.get<string>('dataDatabase.database', './data/openwa.sqlite'));
    }
    tightenSqliteFilePermissions(paths, message => this.logger.warn(message));
  }
}
