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
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { SendPacingService } from '../../modules/message/send-pacing.service';
import type { SessionService } from '../../modules/session/session.service';
import type { TemplateService } from '../../modules/template/template.service';
import { IngressProcessor } from '../../modules/queue/processors/ingress.processor';

const BOOTSTRAP = path.resolve(__dirname, 'sandbox', 'worker-bootstrap.ts');
const TS_NODE_OPTS = JSON.stringify({
  module: 'commonjs',
  moduleResolution: 'node',
  resolvePackageJsonExports: false,
  ignoreDeprecations: '6.0',
});

// A reply of about two lines: the length of an ordinary auto-reply or help-desk answer.
const REPLY =
  'Thanks for your message! Our team is available Monday to Friday, 9:00 to 17:00. We will get back to you soon.';

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

describe('a sandboxed hook handler that answers a message with a text reply', () => {
  jest.setTimeout(60000);

  let tmpDir: string;
  let loader: LoaderWithTsWorker;
  let hookManager: HookManager;
  let engine: { sendChatState: jest.Mock; sendTextMessage: jest.Mock };
  let sendCompleted: Promise<void>;
  let completeSend: () => void;
  const previousTyping = process.env.SIMULATE_TYPING;
  const previousTypingMax = process.env.SIMULATE_TYPING_MAX_MS;

  beforeEach(() => {
    sendCompleted = new Promise(resolve => (completeSend = resolve));
    delete process.env.SIMULATE_TYPING;
    delete process.env.SIMULATE_TYPING_MAX_MS;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-hook-reply-'));
    const pkg = path.join(tmpDir, 'plugins', 'greeter');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'manifest.json'),
      JSON.stringify({
        id: 'greeter',
        name: 'Greeter',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        permissions: ['messages:send', 'webhook:ingress'],
        ingress: [
          {
            route: 'support-reply',
            mode: 'async',
            verify: 'core',
            maxBodyBytes: 65536,
            signature: { scheme: 'hmac-sha256', header: 'x-signature' },
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(pkg, 'index.js'),
      `module.exports = class Greeter {
        async onEnable(ctx) {
          ctx.registerHook('message:received', async hookCtx => {
            void ctx.messages.sendText(hookCtx.sessionId, hookCtx.data.from, ${JSON.stringify(REPLY)}).catch(error => {
              ctx.logger.error('Reply failed', error);
            });
            return { continue: false };
          });
          // A help-desk answer relayed to the WhatsApp contact.
          ctx.registerWebhook('support-reply', async req => {
            const { to, text } = JSON.parse(req.body);
            await ctx.messages.sendText(req.sessionId, to, text);
            return { status: 200 };
          });
        }
      };`,
    );

    // A connected engine: the typing indicator is instant and the send itself is acknowledged in 0.8 s.
    engine = {
      sendChatState: jest.fn().mockResolvedValue(undefined),
      sendTextMessage: jest.fn(
        () =>
          new Promise(resolve =>
            setTimeout(() => {
              resolve({ id: 'wa-out-1', timestamp: 1700000000 });
              completeSend();
            }, 800),
          ),
      ),
    };
    const engines = new EngineRegistry();
    engines.set('sess-1', engine as never);
    hookManager = new HookManager();
    const sender = new MessageSendService(
      {
        create: (data: object) => ({ id: 'row-1', ...data }),
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
    await loader.disablePlugin('greeter').catch(() => undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousTyping === undefined) delete process.env.SIMULATE_TYPING;
    else process.env.SIMULATE_TYPING = previousTyping;
    if (previousTypingMax === undefined) delete process.env.SIMULATE_TYPING_MAX_MS;
    else process.env.SIMULATE_TYPING_MAX_MS = previousTypingMax;
  });

  it('claims the message within the hook budget and is not reported as timed out', async () => {
    await loader.enablePlugin('greeter');

    const result = await hookManager.execute(
      'message:received',
      { id: 'in-1', chatId: '12025550101@c.us', from: '12025550101@c.us', body: 'hello' },
      { sessionId: 'sess-1', source: 'Engine' },
    );
    await sendCompleted;

    expect(engine.sendTextMessage).toHaveBeenCalledWith('12025550101@c.us', REPLY);
    expect(result.continue).toBe(false);
    const health = await loader.checkPluginHealth('greeter');
    expect(health.message ?? '').not.toContain('timed out');
  });

  it('completes a webhook delivery whose handler relays the reply, instead of failing it for a retry', async () => {
    await loader.enablePlugin('greeter');
    const body = JSON.stringify({ to: '12025550101@c.us', text: REPLY });

    const processor = new IngressProcessor(loader, {} as never, hookManager, {} as never, {} as never);
    const dispatch = processor.process({
      id: 'job-1',
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: {
        pluginId: 'greeter',
        instanceId: 'helpdesk',
        route: 'support-reply',
        method: 'POST',
        deliveryId: 'delivery-1',
        sessionId: 'sess-1',
        payload: { headers: {}, query: {}, body, rawBody: body, admission: { verified: true } },
      },
    } as never);
    const outcome = await dispatch.then(
      () => 'completed',
      (error: Error) => `failed: ${error.message}`,
    );
    await sendCompleted;

    // The engine mock completed the send, so the delivery should not enter the retry path.
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('completed');
  });
});
