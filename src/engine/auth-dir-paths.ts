import * as fs from 'fs';
import * as path from 'path';

/**
 * The on-disk engine auth directories, keyed by the session's UUID (`Session.id`).
 *
 * They used to be keyed by `Session.name`. Names are unique case-sensitively, so `my-bot` and
 * `My-Bot` are two rows, but on a case-insensitive filesystem (macOS APFS, Windows, and Docker
 * Desktop bind mounts of a host directory on either) they resolved to ONE directory: the second
 * session loaded the first one's WhatsApp login, and deleting either wiped both (#1597). A UUID has
 * no case variants, so the key is unambiguous on every filesystem.
 *
 * These two builders are the single source of truth for the paths: the adapters build them to write
 * credentials, EngineFactory to pre-create and purge them, and the boot migration to rename the
 * legacy name-keyed directories onto them.
 */

/** whatsapp-web.js LocalAuth profile dir: `sessionDataPath` resolved, then `session-<id>` appended. */
export function wwjsAuthDir(sessionDataPath: string, sessionId: string): string {
  return path.join(path.resolve(sessionDataPath), `session-${sessionId}`);
}

/** Baileys multi-file auth dir: `authDir/<id>`, with `authDir` left unresolved, as the adapter does. */
export function baileysAuthDir(authDir: string, sessionId: string): string {
  return path.join(authDir, sessionId);
}

/**
 * The auth-directory entries directly under `base`, by exact name. Throws whatever `readdir` throws,
 * so a caller can tell a missing base directory (ENOENT) from one it may not read.
 *
 * Every caller that acts on a legacy name-keyed directory matches it against this listing instead of
 * asking `fs.existsSync`: on a case-insensitive filesystem `existsSync` answers yes for
 * `session-My-Bot` when only `session-my-bot` is stored, so the rename or the rm would hit another
 * session's credentials, which is the very bug the id key exists to fix (#1597).
 *
 * A symlink counts as an entry: relocating a large profile onto another volume with one worked while
 * the paths were only ever opened, so renaming or removing the link is what keeps those installs
 * behaving as they did.
 */
export function readAuthDirEntries(base: string): Set<string> {
  return new Set(
    fs
      .readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name),
  );
}
