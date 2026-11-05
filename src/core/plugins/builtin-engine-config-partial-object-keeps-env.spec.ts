jest.mock('../../engine/adapters/whatsapp-web-js.adapter', () => ({
  WhatsAppWebJsAdapter: jest.fn().mockImplementation((config: unknown) => ({ config })),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { PluginType } from './plugin.interfaces';
import { HookManager } from '../hooks';
import { PluginsService } from '../../modules/plugins/plugins.service';
import { WhatsAppWebJsPlugin } from '../../engine/builtin/whatsapp-web-js';
import { WhatsAppWebJsAdapter } from '../../engine/adapters/whatsapp-web-js.adapter';

const manifest = {
  id: 'whatsapp-web.js',
  name: 'WhatsApp Web.js Engine',
  version: '1.0.0',
  type: PluginType.ENGINE,
  main: 'index.ts',
};

// What configuration.ts builds from PUPPETEER_HEADLESS=false and PUPPETEER_ARGS on a host that runs Chromium headful
// with its own launch flags.
const envEngineConfig = {
  sessionDataPath: './data/sessions',
  puppeteer: { headless: false, args: ['--no-sandbox', '--proxy-server=socks5://10.0.0.5:1080', '--lang=en-US'] },
};

describe('a built-in engine config stored as part of a nested object', () => {
  let tmpDir: string;
  let config: ConfigService;

  beforeEach(() => {
    (WhatsAppWebJsAdapter as unknown as jest.Mock).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-engine-merge-'));
    config = {
      get: (k: string) =>
        k === 'dataDir'
          ? tmpDir
          : k === 'plugins.dir'
            ? path.join(tmpDir, 'plugins')
            : k === 'engine.type'
              ? 'whatsapp-web.js'
              : undefined,
    } as unknown as ConfigService;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const boot = async () => {
    const loader = new PluginLoaderService(config, new HookManager(), new PluginStorageService(config), {
      get: () => undefined,
    } as unknown as ModuleRef);
    const plugin = new WhatsAppWebJsPlugin(envEngineConfig);
    loader.registerBuiltInPlugin(manifest, plugin, envEngineConfig);
    await loader.enablePlugin('whatsapp-web.js');
    return { loader, plugin, service: new PluginsService(loader, config) };
  };

  const launchedBrowser = (plugin: WhatsAppWebJsPlugin) => {
    plugin.createEngine({ sessionId: 'sess-1' });
    const calls = (WhatsAppWebJsAdapter as unknown as jest.Mock).mock.calls as unknown[][];
    return (calls[calls.length - 1][0] as { puppeteer: Record<string, unknown> }).puppeteer;
  };

  it('keeps the .env headless mode and launch flags the stored object does not name', async () => {
    const { plugin, service } = await boot();
    expect(launchedBrowser(plugin)).toEqual(
      expect.objectContaining({ headless: false, args: envEngineConfig.puppeteer.args }),
    );

    const saved = service.updateConfig('whatsapp-web.js', { puppeteer: { protocolTimeoutMs: 300_000 } });
    expect(saved.success).toBe(true);

    expect(launchedBrowser(plugin)).toEqual({
      headless: false,
      args: envEngineConfig.puppeteer.args,
      executablePath: undefined,
      protocolTimeoutMs: 300_000,
    });
  });

  it('keeps them after a restart too', async () => {
    const first = await boot();
    first.service.updateConfig('whatsapp-web.js', { puppeteer: { protocolTimeoutMs: 300_000 } });

    const second = await boot();

    expect(launchedBrowser(second.plugin)).toEqual({
      headless: false,
      args: envEngineConfig.puppeteer.args,
      executablePath: undefined,
      protocolTimeoutMs: 300_000,
    });
  });

  it('persists sibling options across sequential partial writes and a restart', async () => {
    const first = await boot();
    first.service.updateConfig('whatsapp-web.js', { puppeteer: { headless: true } });
    first.service.updateConfig('whatsapp-web.js', { puppeteer: { protocolTimeoutMs: 300_000 } });

    expect(first.loader.getRegistryEntry('whatsapp-web.js')?.config).toEqual({
      puppeteer: { headless: true, protocolTimeoutMs: 300_000 },
    });
    const second = await boot();
    expect(launchedBrowser(second.plugin)).toEqual({
      headless: true,
      args: envEngineConfig.puppeteer.args,
      executablePath: undefined,
      protocolTimeoutMs: 300_000,
    });
  });

  it('removes only a nested null override and restores the environment value', async () => {
    const first = await boot();
    first.service.updateConfig('whatsapp-web.js', { puppeteer: { headless: true, protocolTimeoutMs: 300_000 } });
    first.service.updateConfig('whatsapp-web.js', { puppeteer: { headless: null } });

    expect(first.loader.getRegistryEntry('whatsapp-web.js')?.config).toEqual({
      puppeteer: { protocolTimeoutMs: 300_000 },
    });
    expect(launchedBrowser(first.plugin).headless).toBe(false);
    const second = await boot();
    expect(launchedBrowser(second.plugin)).toEqual({
      headless: false,
      args: envEngineConfig.puppeteer.args,
      executablePath: undefined,
      protocolTimeoutMs: 300_000,
    });
  });

  it('removes an override that has no environment fallback', async () => {
    const { loader, plugin, service } = await boot();
    service.updateConfig('whatsapp-web.js', { puppeteer: { protocolTimeoutMs: 300_000 } });
    service.updateConfig('whatsapp-web.js', { puppeteer: { protocolTimeoutMs: null } });

    expect(loader.getRegistryEntry('whatsapp-web.js')?.config).toEqual({ puppeteer: {} });
    expect(launchedBrowser(plugin).protocolTimeoutMs).toBeUndefined();
    expect(launchedBrowser(plugin).args).toEqual(envEngineConfig.puppeteer.args);
  });

  it('replaces a stored array instead of appending environment arguments', async () => {
    const first = await boot();
    first.service.updateConfig('whatsapp-web.js', { puppeteer: { args: ['--disable-gpu'] } });
    first.service.updateConfig('whatsapp-web.js', { puppeteer: { protocolTimeoutMs: 300_000 } });

    expect(launchedBrowser(first.plugin).args).toEqual(['--disable-gpu']);
    const second = await boot();
    expect(launchedBrowser(second.plugin).args).toEqual(['--disable-gpu']);
  });

  it('keeps extension base writes shallow and their null values explicit', async () => {
    const { loader, service } = await boot();
    const dir = path.join(tmpDir, 'plugins', 'relay');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'relay', name: 'Relay', version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    loader.loadPlugin(dir);
    service.updateConfig('relay', { nested: { first: 1, second: 2 }, nullable: 'value' });
    service.updateConfig('relay', { nested: { first: 3 }, nullable: null });

    expect(loader.getPlugin('relay')?.config).toEqual({ nested: { first: 3 }, nullable: null });
    expect(loader.getRegistryEntry('relay')?.config).toEqual({ nested: { first: 3 }, nullable: null });
  });
});
