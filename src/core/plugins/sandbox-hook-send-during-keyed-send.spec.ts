import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { WorkerThreadChannel } from './sandbox/worker-thread-channel';
import { PluginLogLevel } from './sandbox/protocol';
import { PLUGIN_INSTANCE_PORT, PLUGIN_MESSAGE_PORT, PLUGIN_SESSION_PORT } from './plugin-host-ports';
import { MessageSendService } from '../../modules/message/message-send.service';
import { runClaimedSend } from '../../modules/message/idempotency/run-idempotent-send';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { SendIdempotencyService } from '../../modules/message/idempotency/send-idempotency.service';
import type { SendPacingService } from '../../modules/message/send-pacing.service';
import type { SessionService } from '../../modules/session/session.service';
import type { TemplateService } from '../../modules/template/template.service';

const BOOTSTRAP = path.resolve(__dirname, 'sandbox', 'worker-bootstrap.ts');
const TS_NODE_OPTS = JSON.stringify({
  module: 'commonjs',
  moduleResolution: 'node',
  resolvePackageJsonExports: false,
  ignoreDeprecations: '6.0',
});

const CUSTOMER = '12025550101@c.us';
const COLLEAGUE = '12025550102@c.us';

/** The production worker host, built on the TypeScript bootstrap so the spec needs no compiled dist. */
class LoaderWithTsWorker extends PluginLoaderService {
  protected createSandboxHost(
    capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
    onHookSubscribe?: (event: string, priority?: number) => void,
    onWebhookSubscribe?: (route: string) => void,
    onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
    runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
    onSearchProviderRegister?: () => void,
    onWorkerExit?: (code: number, intentional: boolean, reason?: string) => void,
    onUnresponsive?: () => void,
  ): PluginWorkerHost {
    return new PluginWorkerHost(
      new WorkerThreadChannel({
        workerEntry: BOOTSTRAP,
        execArgv: ['-r', 'ts-node/register/transpile-only'],
        env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TS_NODE_OPTS },
      }),
      capDispatcher,
      onHookSubscribe,
      onWebhookSubscribe,
      onLog,
      runWithHookGuard,
      32,
      onSearchProviderRegister,
      onWorkerExit,
      30000,
      5000,
      onUnresponsive,
    );
  }
}

/**
 * A keyed send records on its claim that its message may go out right before its engine call. The record follows the
 * async context the claim runs the send in, so a send a plugin's hook starts while the keyed send is in flight must not
 * be taken for it: recorded early, the claim would read as possibly sent although its own message never reached the
 * engine. A plugin's hook handler runs in its worker, and the send it asks for comes back to the gateway on the
 * worker's port, outside the keyed request's context.
 */
describe('a send a sandboxed hook starts while a keyed send is in flight', () => {
  jest.setTimeout(60000);

  let tmpDir: string;
  let loader: LoaderWithTsWorker;
  let hookManager: HookManager;
  let sender: MessageSendService;
  let order: string[];
  const previousTyping = process.env.SIMULATE_TYPING;

  beforeEach(() => {
    process.env.SIMULATE_TYPING = 'false';
    order = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-keyed-hook-send-'));
    const pkg = path.join(tmpDir, 'plugins', 'escalator');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'manifest.json'),
      JSON.stringify({
        id: 'escalator',
        name: 'Escalator',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        permissions: ['messages:send'],
      }),
    );
    // Copies every message the account sends to a customer to a colleague, before it goes out.
    fs.writeFileSync(
      path.join(pkg, 'index.js'),
      `module.exports = class Escalator {
        async onEnable(ctx) {
          ctx.registerHook('message:sending', async hookCtx => {
            if (hookCtx.data.input.chatId === ${JSON.stringify(CUSTOMER)}) {
              await ctx.messages.sendText(hookCtx.sessionId, ${JSON.stringify(COLLEAGUE)}, 'Sent to the customer: ' + hookCtx.data.input.text);
            }
            return { continue: true };
          });
        }
      };`,
    );

    const engine = {
      sendChatState: jest.fn().mockResolvedValue(undefined),
      sendTextMessage: jest.fn((chatId: string) => {
        order.push(`engine ${chatId}`);
        return Promise.resolve({ id: `wa-${chatId}`, timestamp: 1700000000 });
      }),
    };
    const engines = new EngineRegistry();
    engines.set('sess-1', engine as never);
    hookManager = new HookManager();
    let rows = 0;
    sender = new MessageSendService(
      {
        create: (data: object) => ({ id: `row-${++rows}`, ...data }),
        save: (row: object) => Promise.resolve(row),
        findOne: () => Promise.resolve(null),
        update: () => Promise.resolve({ affected: 1 }),
        delete: () => Promise.resolve({ affected: 1 }),
      } as never,
      { findOne: () => Promise.resolve({ id: 'sess-1', phone: '12025550100' }) } as unknown as SessionService,
      engines,
      hookManager,
      {} as unknown as TemplateService,
      {
        assertSendAllowed: () => Promise.resolve(undefined),
        recordSendFailure: () => undefined,
        recordSendSuccess: () => undefined,
      } as unknown as SendPacingService,
    );
    const instance = { enabled: true, sessionScope: 'sess-1', config: {} };
    const ports = new Map<unknown, unknown>([
      [PLUGIN_MESSAGE_PORT, sender],
      [PLUGIN_SESSION_PORT, { getEngine: () => engine, findOne: () => Promise.resolve({}) }],
      [PLUGIN_INSTANCE_PORT, { resolve: () => Promise.resolve(instance), list: () => Promise.resolve([instance]) }],
    ]);
    const moduleRef = {
      get: (token: unknown) => {
        if (!ports.has(token)) throw new Error('no provider for this port');
        return ports.get(token);
      },
    } as unknown as ModuleRef;
    const config = {
      get: (k: string) => (k === 'dataDir' ? tmpDir : k === 'plugins.dir' ? path.join(tmpDir, 'plugins') : undefined),
    } as unknown as ConfigService;
    loader = new LoaderWithTsWorker(config, hookManager, new PluginStorageService(config), moduleRef);
    loader.onModuleInit();
  });

  afterEach(async () => {
    await loader.disablePlugin('escalator').catch(() => undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousTyping === undefined) delete process.env.SIMULATE_TYPING;
    else process.env.SIMULATE_TYPING = previousTyping;
  });

  it("leaves the keyed send's claim alone, which records its hand-over only for its own message", async () => {
    await loader.enablePlugin('escalator');
    const handOver = jest.fn(() => {
      order.push('hand-over');
      return Promise.resolve();
    });
    const store = {
      handOver,
      complete: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as SendIdempotencyService;

    await runClaimedSend(store, 'claim-1', () =>
      sender.sendText('sess-1', { chatId: CUSTOMER, text: 'Your order shipped.' }),
    );

    expect(order).toEqual([`engine ${COLLEAGUE}`, 'hand-over', `engine ${CUSTOMER}`]);
    expect(handOver).toHaveBeenCalledTimes(1);
  });
});
