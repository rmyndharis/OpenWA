import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BufferJSON } from '@whiskeysockets/baileys';
import { type BaileysAuthLib, useAtomicMultiFileAuthState } from './baileys-auth-store';

describe('useAtomicMultiFileAuthState', () => {
  let dir: string;
  let lib: BaileysAuthLib;
  let initAuthCreds: jest.Mock;
  let fromObject: jest.Mock;
  let logger: { warn: jest.Mock; error: jest.Mock };

  const load = () => useAtomicMultiFileAuthState(dir, lib, logger);
  const write = (file: string, data: unknown) =>
    fs.writeFileSync(path.join(dir, file), JSON.stringify(data, BufferJSON.replacer));
  const leftovers = () => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-auth-')), 'session');
    initAuthCreds = jest.fn(() => ({ fresh: true }));
    fromObject = jest.fn((o: object) => ({ revived: o }));
    lib = { initAuthCreds, BufferJSON, proto: { Message: { AppStateSyncKeyData: { fromObject } } } } as never;
    logger = { warn: jest.fn(), error: jest.fn() };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('creates the folder and mints new creds on a first link', async () => {
    const { state } = await load();

    expect(state.creds).toEqual({ fresh: true });
    expect(initAuthCreds).toHaveBeenCalledTimes(1);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('refuses a folder path that is a file', async () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'x');

    await expect(load()).rejects.toThrow(/not a directory/);
  });

  it('saves creds atomically and loads them back with their Buffers', async () => {
    const first = await load();
    Object.assign(first.state.creds, { noiseKey: { private: Buffer.from([1, 2, 3]) } });
    await first.saveCreds();

    expect(leftovers()).toEqual([]);
    const second = await load();
    expect(initAuthCreds).toHaveBeenCalledTimes(1);
    expect(second.state.creds).toEqual({ fresh: true, noiseKey: { private: Buffer.from([1, 2, 3]) } });
  });

  it.each(['{"noiseKey":', '', 'null'])(
    'moves an unusable creds.json (%j) aside with its key files and starts a new link',
    async raw => {
      fs.mkdirSync(path.join(dir, 'corrupt-1'), { recursive: true });
      const files = { 'creds.json': raw, 'pre-key-1.json': '{"k":1}', 'session-x.0.json': '{"s":1}' };
      for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);

      const { state } = await load();

      expect(state.creds).toEqual({ fresh: true });
      const entries = fs.readdirSync(dir);
      const quarantined = entries.filter(f => f.startsWith('corrupt-') && f !== 'corrupt-1');
      expect(quarantined).toHaveLength(1);
      expect(entries.sort()).toEqual(['corrupt-1', quarantined[0]].sort());
      expect(fs.readdirSync(path.join(dir, 'corrupt-1'))).toEqual([]);
      for (const [name, body] of Object.entries(files)) {
        expect(fs.readFileSync(path.join(dir, quarantined[0], name), 'utf-8')).toBe(body);
      }
      expect(await state.keys.get('session', ['x.0'])).toEqual({ 'x.0': null });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(quarantined[0]));
    },
  );

  it('keeps an unparseable creds.json in place until every key file has moved', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const files = { 'creds.json': '{"noiseKey":', 'pre-key-1.json': '{"k":1}', 'session-x.0.json': '{"s":1}' };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    // Both attempts land in the same millisecond, so the retry must not reuse the first attempt's folder name.
    const sameMs = () => jest.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
    sameMs();
    // Directory order is filesystem-defined; list creds.json first, as a hash-ordered directory may.
    const readdir = fs.promises.readdir.bind(fs.promises) as (p: string) => Promise<string[]>;
    jest
      .spyOn(fs.promises, 'readdir')
      .mockImplementationOnce((async (p: string) => [
        'creds.json',
        ...(await readdir(p)).filter(f => f !== 'creds.json'),
      ]) as never);
    const rename = fs.promises.rename.bind(fs.promises);
    jest
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from, to) =>
        path.basename(String(from)) === 'session-x.0.json' ? Promise.reject(new Error('EBUSY')) : rename(from, to),
      );

    await expect(load()).rejects.toThrow('EBUSY');
    expect(fs.readFileSync(path.join(dir, 'creds.json'), 'utf-8')).toBe(files['creds.json']);
    expect(initAuthCreds).not.toHaveBeenCalled();

    jest.restoreAllMocks();
    sameMs();
    const { state } = await load();
    expect(state.creds).toEqual({ fresh: true });
    expect(fs.readdirSync(dir).every(f => f.startsWith('corrupt-'))).toBe(true);
  });

  it('fails instead of relinking when creds.json exists but cannot be read', async () => {
    fs.mkdirSync(path.join(dir, 'creds.json'), { recursive: true });

    await expect(load()).rejects.toThrow();
    expect(initAuthCreds).not.toHaveBeenCalled();
  });

  it('keeps the previous creds.json and no temp file when the write fails', async () => {
    fs.mkdirSync(dir, { recursive: true });
    write('creds.json', { old: true });
    const { state, saveCreds } = await load();
    Object.assign(state.creds, { old: false });
    jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(saveCreds()).rejects.toThrow('ENOSPC');

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf-8'))).toEqual({ old: true });
    expect(leftovers()).toEqual([]);
  });

  it('leaves the last state after concurrent saves', async () => {
    const { state, saveCreds } = await load();
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      Object.assign(state.creds, { counter: i });
      saves.push(saveCreds());
    }
    await Promise.all(saves);

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf-8'))).toEqual({ fresh: true, counter: 19 });
    expect(leftovers()).toEqual([]);
  });

  it('reads key files in the Baileys multi-file layout and writes them back the same way', async () => {
    fs.mkdirSync(dir, { recursive: true });
    // Baileys maps '/' to '__' and ':' to '-' in file names.
    write('session-123-4@s.whatsapp.net.json', Buffer.from('abc'));
    write('app-state-sync-key-AAA__B.json', { keyData: 'k' });
    const { state } = await load();

    const sessions = await state.keys.get('session', ['123:4@s.whatsapp.net', 'missing']);
    expect(sessions).toEqual({ '123:4@s.whatsapp.net': Buffer.from('abc'), missing: null });
    const syncKeys = await state.keys.get('app-state-sync-key', ['AAA/B']);
    expect(syncKeys['AAA/B']).toEqual({ revived: { keyData: 'k' } });
    expect(fromObject).toHaveBeenCalledWith({ keyData: 'k' });

    await state.keys.set({ 'pre-key': { '7': { public: Buffer.from([7]), private: Buffer.from([8]) } } });
    expect(fs.existsSync(path.join(dir, 'pre-key-7.json'))).toBe(true);
    expect(await state.keys.get('pre-key', ['7'])).toEqual({
      '7': { public: Buffer.from([7]), private: Buffer.from([8]) },
    });
    expect(leftovers()).toEqual([]);

    await state.keys.set({ session: { '123:4@s.whatsapp.net': null } });
    expect(fs.existsSync(path.join(dir, 'session-123-4@s.whatsapp.net.json'))).toBe(false);
  });

  it('reads an unparseable key file as absent', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-key-1.json'), '{');
    const { state } = await load();

    expect(await state.keys.get('pre-key', ['1'])).toEqual({ '1': null });
    expect(logger.warn).toHaveBeenCalled();
  });
});

// scripts/smoke-test-engine-libs.sh imports the real Baileys module in the built image and fails on a
// missing export. Its list has to follow what the adapter reads, or an upstream rename ships unnoticed.
describe('engine library smoke export list', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const script = fs.readFileSync(path.join(root, 'scripts', 'smoke-test-engine-libs.sh'), 'utf8');
  const used = [.../const used = \[([^\]]*)\]/.exec(script)![1].matchAll(/'([^']+)'/g)].map(m => m[1]);

  it('covers every export the auth store takes from the module', () => {
    const source = fs.readFileSync(path.join(__dirname, 'baileys-auth-store.ts'), 'utf8');
    const picked = /Pick<typeof BaileysLib, ([^>]+)>/
      .exec(source)![1]
      .match(/'[^']+'/g)!
      .map(n => n.slice(1, -1));
    expect(picked.length).toBeGreaterThan(0);
    expect(used).toEqual(expect.arrayContaining(picked));
  });

  it('lists only exports the engine code still uses', () => {
    const dir = path.join(root, 'src', 'engine');
    const code = fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(used.filter(name => name !== 'default' && !new RegExp(`\\b${name}\\b`).test(code))).toEqual([]);
  });
});
