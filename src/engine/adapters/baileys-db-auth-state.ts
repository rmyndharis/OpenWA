import * as fs from 'fs';
import * as path from 'path';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import type { BaileysAuthStateStore } from '../types/baileys.types';
import type { createLogger } from '../../common/services/logger.service';

/**
 * The slice of the Baileys module `useDatabaseAuthState` needs. Structural on purpose: the library
 * is ESM-only and lazily loaded by the lifecycle, so the caller hands the loaded module in rather
 * than this file importing it at boot.
 */
export interface BaileysAuthLib {
  initAuthCreds: () => AuthenticationCreds;
  BufferJSON: {
    replacer: (key: string, value: unknown) => unknown;
    reviver: (key: string, value: unknown) => unknown;
  };
  proto: { Message: { AppStateSyncKeyData: { fromObject(obj: unknown): unknown } } };
}

/**
 * Same character mapping `useMultiFileAuthState` applies to file names, applied to key ids on every
 * store read AND write. This keeps database ids byte-identical to the file names a disk import
 * copies in, so a session imported from disk answers the same `keys.get` calls it did before.
 */
const sanitizeKeyId = (id: string): string => id.replace(/\//g, '__').replace(/:/g, '-');

/** Signal key categories as they appear in file names, longest-first so prefix matching is unambiguous. */
const KNOWN_KEY_TYPES = [
  'app-state-sync-version',
  'app-state-sync-key',
  'sender-key-memory',
  'sender-key',
  'pre-key',
  'session',
];

const CREDS = 'creds';

/**
 * Database-backed replacement for `useMultiFileAuthState` — the change that makes a Baileys session
 * portable across nodes. Mirrors the multi-file semantics exactly (BufferJSON serialization,
 * app-state-sync-key proto revival, delete-on-null) against a {@link BaileysAuthStateStore}, and
 * performs a ONE-SHOT import of an existing multi-file directory the first time a session starts in
 * database mode, so switching `BAILEYS_AUTH_STORE` never forces a re-pair. The disk directory is
 * left untouched as a fallback; database rows win from then on.
 */
export async function useDatabaseAuthState(
  lib: BaileysAuthLib,
  store: BaileysAuthStateStore,
  sessionName: string,
  options: { importFromDir?: string; logger?: ReturnType<typeof createLogger> } = {},
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const serialize = (value: unknown): string => JSON.stringify(value, lib.BufferJSON.replacer);
  const deserialize = (value: string): unknown => JSON.parse(value, lib.BufferJSON.reviver) as unknown;

  if (options.importFromDir && !(await store.hasCreds(sessionName))) {
    await importMultiFileDir(store, sessionName, options.importFromDir, options.logger);
  }

  const storedCreds = await store.read(sessionName, CREDS, [CREDS]);
  const creds: AuthenticationCreds = storedCreds[CREDS]
    ? (deserialize(storedCreds[CREDS]) as AuthenticationCreds)
    : lib.initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const stored = await store.read(
            sessionName,
            type,
            ids.map(id => sanitizeKeyId(id)),
          );
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            const raw = stored[sanitizeKeyId(id)];
            if (raw === undefined) continue;
            let value = deserialize(raw);
            if (type === 'app-state-sync-key' && value) {
              value = lib.proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value as SignalDataTypeMap[T];
          }
          return data;
        },
        set: async (data): Promise<void> => {
          const entries: Array<{ keyType: string; keyId: string; value: string | null }> = [];
          for (const category in data) {
            const values = data[category as keyof SignalDataTypeMap];
            for (const id in values) {
              const value: unknown = values[id];
              entries.push({
                keyType: category,
                keyId: sanitizeKeyId(id),
                value: value ? serialize(value) : null,
              });
            }
          }
          await store.write(sessionName, entries);
        },
      },
    },
    saveCreds: async (): Promise<void> => {
      await store.write(sessionName, [{ keyType: CREDS, keyId: CREDS, value: serialize(creds) }]);
    },
  };
}

/**
 * Copy an existing multi-file auth directory into the store, verbatim: file contents are already
 * BufferJSON-serialized JSON and file names already carry sanitized ids, so no re-encoding happens.
 * Unparseable file names are skipped loudly rather than guessed at.
 */
async function importMultiFileDir(
  store: BaileysAuthStateStore,
  sessionName: string,
  dir: string,
  logger?: ReturnType<typeof createLogger>,
): Promise<void> {
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return; // No directory — a genuinely fresh session.
  }

  const entries: Array<{ keyType: string; keyId: string; value: string }> = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let keyType: string;
    let keyId: string;
    if (file === 'creds.json') {
      keyType = CREDS;
      keyId = CREDS;
    } else {
      const base = file.slice(0, -'.json'.length);
      const matched = KNOWN_KEY_TYPES.find(type => base.startsWith(`${type}-`));
      if (!matched) {
        skipped.push(file);
        continue;
      }
      keyType = matched;
      keyId = base.slice(matched.length + 1);
    }
    try {
      const value = await fs.promises.readFile(path.join(dir, file), 'utf-8');
      JSON.parse(value); // Integrity check only; the stored form stays the raw serialized string.
      entries.push({ keyType, keyId, value });
    } catch {
      skipped.push(file);
    }
  }

  if (entries.length === 0) return;
  await store.write(sessionName, entries);
  logger?.log(`Imported ${entries.length} auth-state file(s) from disk into the database`, {
    sessionName,
    imported: entries.length,
    skipped: skipped.length,
  });
  if (skipped.length > 0) {
    logger?.warn(`Skipped ${skipped.length} unrecognized/unreadable auth file(s) during import`, {
      sessionName,
      files: skipped.slice(0, 10),
    });
  }
}
