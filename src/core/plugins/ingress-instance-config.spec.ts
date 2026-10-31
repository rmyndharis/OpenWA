import { ConfigService } from '@nestjs/config';
import { HookManager } from '../hooks';
import { PluginSandboxBridge } from './plugin-sandbox-bridge';
import { PluginCapabilityContext } from './plugin-capability-context';
import { PluginHostServices } from './plugin-host-services';
import { PluginStorageService } from './plugin-storage.service';
import { PluginInstance as LoadedPlugin, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { PluginInstance as InstanceRow } from '../../modules/integration/entities/plugin-instance.entity';
import { IngressJobData } from '../../modules/queue/processors/ingress.processor';
import { createLogger } from '../../common/services/logger.service';

// Two enabled instances of ONE plugin may legitimately share a session scope. Provisioning projects
// each instance's config into a scope-keyed store, so the second write overwrites the first — which
// makes the scope an unusable key for resolving WHOSE credentials a delivery must run with. Dispatch
// is per-instance by definition and already holds the instance row, so these pin that the row, not
// the scope, decides the config a delivery is handled with.

const PLUGIN_ID = 'chat-adapter';
const SHARED_SCOPE = 'session-shared';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: PLUGIN_ID,
    name: 'Chat Adapter',
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.js',
    ...overrides,
  };
}

function instanceRow(instanceId: string, config: Record<string, unknown> | null, scope: string | null): InstanceRow {
  return {
    id: `${PLUGIN_ID}:${instanceId}`,
    pluginId: PLUGIN_ID,
    instanceId,
    sessionScope: scope,
    secret: 'secret-' + instanceId,
    verifyToken: null,
    config,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** A job as admission leaves it: the session is the one the instance was bound to. */
function job(
  instanceId: string,
  sessionId: string | null = SHARED_SCOPE,
  admission?: { verified: boolean },
): IngressJobData {
  return {
    pluginId: PLUGIN_ID,
    instanceId,
    route: '/hook',
    deliveryId: 'delivery-' + instanceId,
    sessionId: sessionId ?? undefined,
    payload: { headers: {}, query: {}, body: '{}', rawBody: '{}', ...(admission ? { admission } : {}) },
  };
}

/** The fields of the worker payload these specs assert on. */
type WebhookCall = { config?: Record<string, unknown>; verified?: boolean; sessionId?: string };

/** Builds a bridge whose dispatch path is real; only the worker host and the instance store are fakes. */
function makeBridge(opts: {
  rows: InstanceRow[];
  baseConfig?: Record<string, unknown>;
  sessionConfig?: Record<string, Record<string, unknown>>;
  manifestOverrides?: Partial<PluginManifest>;
}): { bridge: PluginSandboxBridge; calls: WebhookCall[] } {
  const calls: WebhookCall[] = [];
  const dispatchWebhook = (payload: WebhookCall): Promise<{ ok: boolean; status: number }> => {
    calls.push(payload);
    return Promise.resolve({ ok: true, status: 200 });
  };
  const sandboxHosts = new Map<string, PluginWorkerHost>([
    [PLUGIN_ID, { dispatchWebhook } as unknown as PluginWorkerHost],
  ]);

  const plugins = new Map<string, LoadedPlugin>([
    [
      PLUGIN_ID,
      {
        manifest: manifest(opts.manifestOverrides),
        status: PluginStatus.ENABLED,
        config: opts.baseConfig ?? {},
        sessionConfig: opts.sessionConfig,
      } as unknown as LoadedPlugin,
    ],
  ]);

  const hostServices = {
    getPluginInstancePort: () => ({
      resolve: (pluginId: string, instanceId: string) =>
        Promise.resolve(opts.rows.find(r => r.pluginId === pluginId && r.instanceId === instanceId) ?? null),
      list: (pluginId: string) => Promise.resolve(opts.rows.filter(r => r.pluginId === pluginId)),
    }),
  } as unknown as PluginHostServices;

  const bridge = new PluginSandboxBridge(
    createLogger('test'),
    new HookManager(),
    undefined as unknown as PluginCapabilityContext,
    hostServices,
    undefined as unknown as ConfigService,
    undefined as unknown as PluginStorageService,
    plugins,
    sandboxHosts,
    new Map(),
    '/plugins',
    (() => undefined) as never,
    () => '/plugins/index.js',
  );
  return { bridge, calls };
}

describe('ingress dispatch resolves config per INSTANCE, not per session scope', () => {
  it('hands each instance its own credentials when two instances share one session scope', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE);
    const b = instanceRow('acct-b', { apiToken: 'token-B' }, SHARED_SCOPE);
    // Provisioning wrote both to the same scope key; the second write won.
    const { bridge, calls } = makeBridge({
      rows: [a, b],
      sessionConfig: { [SHARED_SCOPE]: { apiToken: 'token-B' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls).toHaveLength(1);
    expect(calls[0].config).toEqual({ apiToken: 'token-A' });
  });

  it('hands the other instance ITS credentials from the same shared scope', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE);
    const b = instanceRow('acct-b', { apiToken: 'token-B' }, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a, b],
      sessionConfig: { [SHARED_SCOPE]: { apiToken: 'token-B' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-b'));

    expect(calls[0].config).toEqual({ apiToken: 'token-B' });
  });

  /**
   * Layering the row on top corrects only the keys the row DEFINES. Every key it leaves unset falls
   * through to the layer underneath — and for two instances sharing a scope that layer is not a
   * schema default, it is the other tenant's projected config. So a sparse row, which is the normal
   * shape when an instance relies on a plugin default, still received the sibling's live value.
   *
   * The scope slice cannot be attributed to an instance once siblings exist, so it is not consulted
   * there at all. With a single instance on the scope it still applies: that slice is either that
   * instance's own projection or the operator's deliberate per-session override.
   */
  it('does not hand a sparse instance the sibling tenant value for a key it left unset', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A', endpoint: 'https://a.example' }, SHARED_SCOPE);
    const b = instanceRow('acct-b', { apiToken: 'token-B' }, SHARED_SCOPE); // relies on the default
    const { bridge, calls } = makeBridge({
      rows: [a, b],
      baseConfig: { endpoint: 'https://default.example' },
      // acct-a was provisioned last, so the scope slice carries ITS endpoint.
      sessionConfig: { [SHARED_SCOPE]: { apiToken: 'token-A', endpoint: 'https://a.example' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-b'));

    expect(calls[0].config).toEqual({ apiToken: 'token-B', endpoint: 'https://default.example' });
  });

  // Negative twin: with no sibling the slice IS attributable, so an operator's per-session override
  // must keep applying — dropping it everywhere would break the surface it exists for.
  it('still applies the per-session override when one instance binds the scope', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a],
      baseConfig: { endpoint: 'https://default.example' },
      sessionConfig: { [SHARED_SCOPE]: { endpoint: 'https://operator.example' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({ apiToken: 'token-A', endpoint: 'https://operator.example' });
  });

  /**
   * A DISABLED sibling is not a tenant receiving deliveries, so it cannot be the one the slice was
   * projected for in any way that matters — counting it would drop the operator's override for a
   * deployment that has only one live instance.
   */
  it('a disabled sibling does not make the scope unattributable', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE);
    const retired = { ...instanceRow('acct-b', { apiToken: 'token-B' }, SHARED_SCOPE), enabled: false };
    const { bridge, calls } = makeBridge({
      rows: [a, retired],
      baseConfig: { endpoint: 'https://default.example' },
      sessionConfig: { [SHARED_SCOPE]: { endpoint: 'https://operator.example' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({ apiToken: 'token-A', endpoint: 'https://operator.example' });
  });

  it('keeps plugin-level defaults underneath the instance override', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a],
      // Base carries schema-seeded defaults the instance row does not repeat.
      baseConfig: { apiToken: 'unset', endpoint: 'https://default.example', retries: 3 },
      sessionConfig: { [SHARED_SCOPE]: { apiToken: 'token-A' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({
      apiToken: 'token-A',
      endpoint: 'https://default.example',
      retries: 3,
    });
  });

  it('merges the instance config deeply, so a sparse override cannot drop a nested base key', async () => {
    const a = instanceRow('acct-a', { auth: { token: 'token-A' } }, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a],
      // `auth.region` exists only in the base; a shallow merge would delete it.
      baseConfig: { auth: { token: 'unset', region: 'eu-west-1' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({
      auth: { token: 'token-A', region: 'eu-west-1' },
    });
  });

  it('falls back to the base config when the instance row carries none', async () => {
    const a = instanceRow('acct-a', null, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a],
      baseConfig: { endpoint: 'https://default.example' },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({ endpoint: 'https://default.example' });
  });

  it('isolates instances of a plugin that is NOT session-scoped', async () => {
    // sessionScoped:false previously skipped the override entirely, so every instance of such a
    // plugin was dispatched with one shared config.
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, null);
    const b = instanceRow('acct-b', { apiToken: 'token-B' }, null);
    const { bridge, calls } = makeBridge({
      rows: [a, b],
      baseConfig: { apiToken: 'token-B' },
      manifestOverrides: { sessionScoped: false },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a', null));

    expect(calls[0].config).toEqual({ apiToken: 'token-A' });
  });
});

describe('ingress dispatch does not carry a base secret to another host', () => {
  // An adapter that calls the host named in `baseUrl` with a stored token. A key that may create an
  // instance on one session, or write that session's override, picks the host; the token is the
  // operator's and belongs to the host it was saved for.
  const adapter: Partial<PluginManifest> = {
    net: { allowConfigHosts: ['baseUrl'] },
    configSchema: {
      type: 'object',
      properties: { baseUrl: { type: 'string' }, apiToken: { type: 'string', secret: true } },
    },
  };
  const baseConfig = { baseUrl: 'https://chat.example.com', apiToken: 'OPERATOR-TOKEN' };

  it('withholds the operator token from an instance that names its own host', async () => {
    const tenant = instanceRow('tenant', { baseUrl: 'https://attacker.example' }, 'S1');
    const { bridge, calls } = makeBridge({ rows: [tenant], baseConfig, manifestOverrides: adapter });

    await bridge.dispatchWebhookForInstance(job('tenant', 'S1'));

    expect(calls[0].config).toEqual({ baseUrl: 'https://attacker.example' });
  });

  it('withholds it from an instance on a session whose override names another host', async () => {
    const tenant = instanceRow('tenant', null, 'S1');
    const { bridge, calls } = makeBridge({
      rows: [tenant],
      baseConfig,
      sessionConfig: { S1: { baseUrl: 'https://attacker.example' } },
      manifestOverrides: adapter,
    });

    await bridge.dispatchWebhookForInstance(job('tenant', 'S1'));

    expect(calls[0].config).toEqual({ baseUrl: 'https://attacker.example' });
  });

  // The row's token was provisioned against the operator host. An override written for the same session by a
  // key that cannot read it must not be able to move the host and take the row's token along.
  it('withholds the token an instance holds itself when a session override moved the host', async () => {
    const tenant = instanceRow('tenant', { apiToken: 'TENANT-TOKEN', inboxId: '9' }, 'S1');
    const { bridge, calls } = makeBridge({
      rows: [tenant],
      baseConfig,
      sessionConfig: { S1: { baseUrl: 'https://attacker.example' } },
      manifestOverrides: adapter,
    });

    await bridge.dispatchWebhookForInstance(job('tenant', 'S1'));

    expect(calls[0].config).toEqual({ baseUrl: 'https://attacker.example', inboxId: '9' });
  });

  it('keeps the token an instance holds itself when the override left the host alone', async () => {
    const tenant = instanceRow('tenant', { apiToken: 'TENANT-TOKEN' }, 'S1');
    const { bridge, calls } = makeBridge({
      rows: [tenant],
      baseConfig,
      sessionConfig: { S1: { baseUrl: 'https://chat.example.com/' } },
      manifestOverrides: adapter,
    });

    await bridge.dispatchWebhookForInstance(job('tenant', 'S1'));

    expect(calls[0].config).toMatchObject({ apiToken: 'TENANT-TOKEN' });
  });

  it('keeps the token for an instance that names the operator host or none', async () => {
    const same = instanceRow('same', { baseUrl: 'https://chat.example.com/other' }, 'S1');
    const none = instanceRow('none', {}, 'S2');
    const { bridge, calls } = makeBridge({ rows: [same, none], baseConfig, manifestOverrides: adapter });

    await bridge.dispatchWebhookForInstance(job('same', 'S1'));
    await bridge.dispatchWebhookForInstance(job('none', 'S2'));

    expect(calls[0].config).toMatchObject({ apiToken: 'OPERATOR-TOKEN' });
    expect(calls[1].config).toEqual(baseConfig);
  });

  it('hands an instance the token it brings for its own host', async () => {
    const tenant = instanceRow('tenant', { baseUrl: 'https://other.example', apiToken: 'TENANT-TOKEN' }, 'S1');
    const { bridge, calls } = makeBridge({ rows: [tenant], baseConfig, manifestOverrides: adapter });

    await bridge.dispatchWebhookForInstance(job('tenant', 'S1'));

    expect(calls[0].config).toEqual({ baseUrl: 'https://other.example', apiToken: 'TENANT-TOKEN' });
  });
});

describe('ingress dispatch refuses an instance that is disabled or deleted', () => {
  it('rejects a disabled instance without reaching the worker', async () => {
    const a = { ...instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE), enabled: false };
    const { bridge, calls } = makeBridge({ rows: [a] });

    await expect(bridge.dispatchWebhookForInstance(job('acct-a'))).rejects.toThrow(
      'instance acct-a of plugin chat-adapter is disabled or deleted',
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects a deleted instance instead of dispatching it with the base config a wildcard sibling wrote', async () => {
    // A wildcard instance projects its config into the base config; a job for a row that no longer
    // exists must not run with it.
    const wildcard = instanceRow('acct-b', { apiToken: 'token-B' }, null);
    const { bridge, calls } = makeBridge({ rows: [wildcard], baseConfig: { apiToken: 'token-B' } });

    await expect(bridge.dispatchWebhookForInstance(job('acct-a', null))).rejects.toThrow(
      'instance acct-a of plugin chat-adapter is disabled or deleted',
    );
    expect(calls).toHaveLength(0);
  });
});

const route = (scheme: 'none' | 'hmac-sha256') => ({
  route: '/hook',
  mode: 'async' as const,
  verify: 'core' as const,
  maxBodyBytes: 1024,
  signature: scheme === 'none' ? { scheme: 'none' as const } : { scheme: 'hmac-sha256' as const, header: 'x-sig' },
});

describe('ingress dispatch keeps what was decided when the delivery was admitted', () => {
  const row = () => instanceRow('acct-a', { apiToken: 'token-A' }, 'S1');

  it('does not label an unauthenticated delivery verified after its route starts signing', async () => {
    const { bridge, calls } = makeBridge({
      rows: [row()],
      manifestOverrides: { ingress: [route('hmac-sha256')] },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a', 'S1', { verified: false }));

    expect(calls[0].verified).toBe(false);
  });

  it('keeps an authenticated delivery verified after its route stops signing', async () => {
    const { bridge, calls } = makeBridge({
      rows: [row()],
      manifestOverrides: { ingress: [route('none')] },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a', 'S1', { verified: true }));

    expect(calls[0].verified).toBe(true);
  });

  it('still never labels a delivery verified when its route is gone', async () => {
    const { bridge, calls } = makeBridge({ rows: [row()] });

    await bridge.dispatchWebhookForInstance(job('acct-a', 'S1', { verified: true }));

    expect(calls[0].verified).toBe(false);
  });

  it.each([
    ['signing', 'hmac-sha256', true],
    ['unsigned', 'none', false],
  ] as const)(
    'reads the route for a delivery admitted before the verdict was recorded (%s)',
    async (_l, scheme, want) => {
      const { bridge, calls } = makeBridge({
        rows: [row()],
        manifestOverrides: { ingress: [route(scheme)] },
      });

      await bridge.dispatchWebhookForInstance(job('acct-a', 'S1'));

      expect(calls[0].verified).toBe(want);
    },
  );

  it('refuses a delivery admitted for a session the instance has since left', async () => {
    const rebound = instanceRow('acct-a', { apiToken: 'token-A' }, 'S-new');
    const { bridge, calls } = makeBridge({ rows: [rebound], sessionConfig: { 'S-new': { endpoint: 'https://new' } } });

    await expect(bridge.dispatchWebhookForInstance(job('acct-a', 'S-old'))).rejects.toThrow(/rebound/);
    expect(calls).toHaveLength(0);
  });

  it('treats null, undefined and * as the one all-sessions scope', async () => {
    const wildcard = instanceRow('acct-a', { apiToken: 'token-A' }, '*');
    const { bridge, calls } = makeBridge({ rows: [wildcard] });

    await bridge.dispatchWebhookForInstance(job('acct-a', null));
    await bridge.dispatchWebhookForInstance(job('acct-a', '*'));

    expect(calls).toHaveLength(2);
  });

  it('refuses a delivery admitted for all sessions once the instance is bound to one', async () => {
    const { bridge, calls } = makeBridge({ rows: [row()] });

    await expect(bridge.dispatchWebhookForInstance(job('acct-a', null))).rejects.toThrow(/rebound/);
    expect(calls).toHaveLength(0);
  });
});
