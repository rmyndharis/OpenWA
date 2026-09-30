import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { type createLogger } from '../../common/services/logger.service';

/** The parts of the lazily loaded Baileys module the store needs (Baileys is ESM-only, never imported here). */
export type BaileysAuthLib = Pick<typeof BaileysLib, 'initAuthCreds' | 'BufferJSON' | 'proto'>;

/**
 * Per-file operation chains, module-level like Baileys' own file locks, so an old socket's in-flight
 * save and a reconnect's read of the same file stay ordered within this process.
 */
const fileChains = new Map<string, Promise<unknown>>();

function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
  const run = (fileChains.get(file) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => undefined);
  fileChains.set(file, tail);
  void tail.then(() => {
    if (fileChains.get(file) === tail) fileChains.delete(file);
  });
  return run;
}

/**
 * Write to a sibling temp file, fsync it, then rename it over the target: a crash or a full disk
 * mid-write leaves the previous complete file, never a truncated one.
 */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Baileys' multi-file auth state (same folder layout and file names as its useMultiFileAuthState,
 * so existing auth dirs load unchanged) with two differences: every write is atomic, and a
 * creds.json that exists but does not parse is moved aside with its key files to `corrupt-<ms>-<suffix>/`
 * and logged before a new link is started, instead of being silently replaced by a fresh identity. A creds.json
 * that cannot be read for another reason (EACCES, EIO) fails the connect rather than relinking.
 */
export async function useAtomicMultiFileAuthState(
  folder: string,
  lib: BaileysAuthLib,
  logger: Pick<ReturnType<typeof createLogger>, 'warn' | 'error'>,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const { BufferJSON, proto, initAuthCreds } = lib;
  const filePath = (file: string): string => path.join(folder, file.replace(/\//g, '__').replace(/:/g, '-'));

  const writeData = (data: unknown, file: string): Promise<void> => {
    const target = filePath(file);
    const json = JSON.stringify(data, BufferJSON.replacer);
    return serialized(target, () => writeFileAtomic(target, json));
  };

  const readKey = (file: string): Promise<unknown> => {
    const target = filePath(file);
    return serialized(target, async () => {
      try {
        return JSON.parse(await fsp.readFile(target, 'utf-8'), BufferJSON.reviver) as unknown;
      } catch (err) {
        // A missing or unreadable key reads as absent, as in Baileys: the Signal session renegotiates.
        if (!isMissing(err)) logger.warn('Unreadable Baileys key file ignored', { file: target });
        return null;
      }
    });
  };

  const removeData = (file: string): Promise<void> => {
    const target = filePath(file);
    return serialized(target, () => fsp.rm(target, { force: true }).catch(() => undefined));
  };

  const folderInfo = await fsp.stat(folder).catch(() => undefined);
  if (folderInfo && !folderInfo.isDirectory()) {
    throw new Error(
      `found something that is not a directory at ${folder}, either delete it or specify a different location`,
    );
  }
  if (!folderInfo) await fsp.mkdir(folder, { recursive: true });

  const credsFile = filePath('creds.json');
  const creds = await serialized(credsFile, async (): Promise<AuthenticationCreds> => {
    let raw: string;
    try {
      raw = await fsp.readFile(credsFile, 'utf-8');
    } catch (err) {
      if (isMissing(err)) return initAuthCreds();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw, BufferJSON.reviver);
    } catch {
      parsed = undefined;
    }
    // Baileys dereferences creds unconditionally, so `null` or a bare value is as unusable as bad JSON.
    if (parsed && typeof parsed === 'object') return parsed as AuthenticationCreds;
    // Move the key files aside too: a new identity must not reuse the old one's Signal sessions and pre-keys.
    const quarantined = await fsp.mkdtemp(path.join(folder, `corrupt-${Date.now()}-`));
    for (const entry of await fsp.readdir(folder)) {
      const from = path.join(folder, entry);
      if (!entry.startsWith('corrupt-') && from !== credsFile) await fsp.rename(from, path.join(quarantined, entry));
    }
    // creds.json goes last: an interrupted move keeps the trigger in place, so the next connect quarantines again.
    await fsp.rename(credsFile, path.join(quarantined, 'creds.json'));
    logger.error(
      `Stored Baileys credentials could not be parsed; moved them to ${quarantined}. The session needs a new QR link.`,
    );
    return initAuthCreds();
  });

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async id => {
              let value = await readKey(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value as SignalDataTypeMap[T];
            }),
          );
          return data;
        },
        set: async data => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const entries = data[category as keyof SignalDataTypeMap] ?? {};
            for (const id in entries) {
              const value = entries[id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}
