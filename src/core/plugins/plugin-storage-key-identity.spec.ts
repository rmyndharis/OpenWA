import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PluginStorageService } from './plugin-storage.service';

// Half of a surrogate pair with no partner: what String.slice leaves when it cuts inside an emoji.
const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xde00);
const GRIN = String.fromCodePoint(0x1f600);
const THINK = String.fromCodePoint(0x1f914);
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * A key a plugin builds from text, such as a prefix cut from a message body at a fixed length, can end in half of a
 * surrogate pair. UTF-8 has no form for it, so every such key at one place would name the same file: the value of one
 * would be read back, replaced or deleted through the other. A key that holds one is refused like any unsafe key.
 */
describe('ctx.storage keys with a lone UTF-16 surrogate', () => {
  let tmpDir: string;
  let pluginDir: string;
  let service: PluginStorageService;
  let store: ReturnType<PluginStorageService['createPluginStorage']>;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-key-identity-'));
    pluginDir = path.join(tmpDir, 'plugins', 'crm-sync');
    service = new PluginStorageService({
      get: (k: string) => (k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService);
    store = service.createPluginStorage('crm-sync');
    warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockReturnValue();
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const cut = (emoji: string): string => `seen:${emoji}`.slice(0, 'seen:'.length + 1);

  it.each([
    ['a high surrogate at the end', `seen:${LONE_HIGH}`],
    ['a low surrogate at the end', `seen:${LONE_LOW}`],
    ['a lone surrogate inside the key', `a${LONE_HIGH}b`],
    ['a high surrogate followed by another', `${LONE_HIGH}${LONE_HIGH}`],
  ])('refuses %s: set and delete reject, get answers null, nothing is written', async (_name, key) => {
    await expect(store.set(key, 'value')).rejects.toThrow(/Unsafe plugin storage key/);
    await expect(store.delete(key)).rejects.toThrow(/Unsafe plugin storage key/);
    await expect(store.get(key)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsafe key'));
    expect(fs.readdirSync(pluginDir)).toEqual([]);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('cannot reach the value of one cut key through another', async () => {
    const cutGrin = cut(GRIN);
    const cutThink = cut(THINK);
    expect(cutGrin).not.toBe(cutThink);

    await expect(store.set(cutGrin, 'grin')).rejects.toThrow();
    await expect(store.set(cutThink, 'think')).rejects.toThrow();
    await expect(store.get(cutGrin)).resolves.toBeNull();
    await expect(store.get(cutThink)).resolves.toBeNull();
  });

  it('keeps keys with whole emoji, which are not lone surrogates, as separate records', async () => {
    await store.set(`seen:${GRIN}`, 'grin');
    await store.set(`seen:${THINK}`, 'think');

    await expect(store.get(`seen:${GRIN}`)).resolves.toBe('grin');
    await expect(store.get(`seen:${THINK}`)).resolves.toBe('think');
    await expect(store.list()).resolves.toHaveLength(2);
  });

  it('still stores a key that holds U+FFFD itself', async () => {
    await store.set(`seen:${REPLACEMENT}`, 'replacement');
    await expect(store.get(`seen:${REPLACEMENT}`)).resolves.toBe('replacement');
    await expect(store.list()).resolves.toEqual([`seen:${REPLACEMENT}`]);
  });

  it('leaves a record written under the lossy name reachable through the well-formed spelling of its key', async () => {
    // Before the refusal, a key ending in a lone surrogate was stored under the name of the same key ending in
    // U+FFFD. That file is where it was, and the well-formed spelling still reads, lists and deletes it.
    const encoded = Buffer.from(`seen:${REPLACEMENT}`, 'utf8').toString('base64url');
    fs.writeFileSync(path.join(pluginDir, `key-${encoded}.json`), JSON.stringify('older record'));

    await expect(store.get(`seen:${LONE_HIGH}`)).resolves.toBeNull();
    await expect(store.get(`seen:${REPLACEMENT}`)).resolves.toBe('older record');
    await expect(store.list()).resolves.toEqual([`seen:${REPLACEMENT}`]);
    await store.delete(`seen:${REPLACEMENT}`);
    await expect(store.list()).resolves.toEqual([]);
  });
});
