import { chmodSync, existsSync } from 'fs';
import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { createLogger } from '../common/services/logger.service';

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
export class SqlitePermissionsBoot implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = createLogger('SqlitePermissions');

  constructor(
    private readonly config: ConfigService,
    @Optional() @InjectDataSource('main') private readonly mainDataSource?: DataSource,
    @Optional() @InjectDataSource('data') private readonly dataDataSource?: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    const paths: string[] = [this.config.get<string>('database.database', './data/main.sqlite')];
    if (this.config.get<string>('dataDatabase.type', 'sqlite') !== 'postgres') {
      paths.push(this.config.get<string>('dataDatabase.database', './data/openwa.sqlite'));
    }
    tightenSqliteFilePermissions(paths, message => this.logger.warn(message));
  }

  /**
   * Flushes and truncates SQLite WAL files during clean shutdown.
   * Runs after all `onModuleDestroy` writers have finished and before `TypeOrmCoreModule.onApplicationShutdown`
   * closes the DataSources, leaving a self-contained database file for offline copies and backups.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.config.get<string>('database.journalMode', 'WAL') !== 'WAL') return;

    const connections: Array<[string, DataSource | undefined]> = [
      ['main', this.mainDataSource],
      ['data', this.dataDataSource],
    ];
    for (const [label, ds] of connections) {
      if (!ds || !ds.isInitialized) continue;
      if (ds.options.type !== 'better-sqlite3') continue;
      if (String(ds.options.database ?? '').trim() === ':memory:') continue;
      try {
        const result = await ds.query<Array<{ busy?: number; log?: number; checkpointed?: number }> | undefined>(
          'PRAGMA wal_checkpoint(TRUNCATE)',
        );
        const row = Array.isArray(result) ? result[0] : undefined;
        if (row) {
          const busy = typeof row.busy === 'number' ? row.busy : 0;
          const log = typeof row.log === 'number' ? row.log : 0;
          const checkpointed = typeof row.checkpointed === 'number' ? row.checkpointed : 0;
          if (busy !== 0 || checkpointed < log) {
            this.logger.warn(
              `SQLite WAL checkpoint on shutdown was incomplete for ${label} connection ` +
                `(busy=${busy}, checkpointed=${checkpointed}, log=${log})`,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `Could not checkpoint SQLite WAL for ${label} connection on shutdown: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
