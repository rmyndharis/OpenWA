import { writeFileSync, chmodSync } from 'fs';
import { createLogger } from '../services/logger.service';

const logger = createLogger('SecretFile');

/**
 * Write a secret file (e.g. the generated `.env`, the raw admin key) with owner-only permissions.
 *
 * `writeFileSync`'s `mode` is honored only when the file is CREATED — on an overwrite it keeps the
 * existing permissions. So we chmod to 0o600 BEFORE writing too: if the file already exists with
 * looser perms, the new secret content is never briefly world-readable during the rewrite. The
 * post-write chmod is a backstop. Both chmods are best-effort (a mount that can't chmod, or an
 * absent file on the pre-write call, shouldn't break the write — create-mode covers new files).
 */
export function writeSecretFile(
  filePath: string,
  content: string,
  // The env loader defers its own lines until LOG_LEVEL is applied and passes a sink that joins them.
  warn: (message: string) => void = message => logger.warn(message),
): void {
  try {
    chmodSync(filePath, 0o600);
  } catch (error) {
    // A file not present yet is expected: create-mode below covers it. Log any other failure so a
    // world-readable secret on a chmod-unsupported FS (or an unexpected error) is not silently left
    // world-readable after a rewrite.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`pre-write chmod 0o600 failed for ${filePath}: ${(error as Error).message}`);
    }
  }
  writeFileSync(filePath, content, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch (error) {
    warn(`post-write chmod 0o600 failed for ${filePath}: ${(error as Error).message}`);
  }
}
