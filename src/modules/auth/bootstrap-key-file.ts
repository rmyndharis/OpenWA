import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { writeSecretFile } from '../../common/utils/secret-file';
import type { LoggerService } from '../../common/services/logger.service';

/**
 * `data/.api-key` — the bootstrap key file.
 *
 * It is an operator convenience: the first-boot banner quotes it, and backup scripts read it. It is
 * never read for seeding or for authentication, so removing it can never lock anyone out.
 *
 * The point of gathering the four file operations here is that the file is a single resource touched
 * by two concerns that otherwise share nothing — first-boot seeding writes it, and admin key
 * lifecycle unlinks it when the key it holds is revoked or deleted. As a module const reached from
 * both, it was the coupling; as a resource with one owner, each concern asks for what it needs.
 *
 * The path resolves PER CALL, and honours `BOOTSTRAP_KEY_FILE`. Both matter: it used to be a const
 * evaluated at import from `process.cwd()`, so nothing could redirect it — which is why an e2e boot
 * (whose setup redirects both databases) still wrote and unlinked the developer's real repo-root
 * `data/.api-key`.
 */
export function bootstrapKeyFilePath(): string {
  return process.env.BOOTSTRAP_KEY_FILE || join(process.cwd(), 'data', '.api-key');
}

/** The raw key the file holds, or null when absent, unreadable or empty. Never throws. */
export function readBootstrapKey(logger: Pick<LoggerService, 'warn'>): string | null {
  const file = bootstrapKeyFilePath();
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf-8').trim() || null;
  } catch (error) {
    logger.warn(`Failed to read API key file: ${file}`, { error: String(error) });
    return null;
  }
}

/** Write the key owner-only (0600) — it is a live credential until the operator rotates it. */
export function writeBootstrapKey(displayKey: string): void {
  writeSecretFile(bootstrapKeyFilePath(), displayKey);
}

/** Remove the file. Absent is success, not a failure — the caller's intent is "make it gone". */
export function removeBootstrapKey(reason: string, logger: Pick<LoggerService, 'log' | 'warn'>): void {
  const file = bootstrapKeyFilePath();
  try {
    unlinkSync(file);
    logger.log(`Removed stale bootstrap API key file (${reason}): ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // already gone
    logger.warn(`Failed to remove stale API key file: ${file}`, { error: String(error) });
  }
}
