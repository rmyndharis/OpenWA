// Render smoke test for the Infrastructure page under the bare `node --test` runner. Mirrors
// Chats.test.ts's harness: same providers, same fetch-stub-with-recorded-calls approach, same
// loader hooks. This page could not be imported by the harness at all before this file existed —
// it imports four SVG icons, and the loader only handled .css/.json/.tsx/.ts (see the `.svg`
// branch added to vite-shim-hooks.mjs alongside this test).
//
// Providers: QueryClientProvider (four GET queries: status/config/engines/current-engine) →
// RoleProvider (harmless here, kept for parity with App.tsx) → ToastProvider (useToast throws
// without it). No Router — the page uses no router hooks.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfraStatus, SavedConfig, Engine } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

// database.host is kept IDENTICAL between /status and /config on purpose: both the live-seed
// effect (from infraStatus) and the saved-config hydrate effect write dbConfig.host, and which one
// wins depends on which query settles last — a race this test does not want to pin. username,
// database name, schema and pool size are written ONLY by the saved-config effect, so asserting on
// those (not host) is what actually proves /config hydration without being timing-sensitive.
const INFRA_STATUS: InfraStatus = {
  database: { connected: true, type: 'postgres', host: 'shared-db-host', builtIn: false },
  redis: { enabled: false, connected: false, host: 'localhost', port: 6379, builtIn: false },
  queue: { enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } },
  storage: { type: 'local', path: './data/media', builtIn: false },
  engine: { type: 'whatsapp-web.js', headless: true },
};

const SAVED_CONFIG: SavedConfig = {
  database: {
    type: 'postgres',
    builtIn: false,
    host: 'shared-db-host',
    port: '6543',
    username: 'openwa_admin',
    database: 'openwa_prod',
    schema: 'appschema',
    poolSize: 7,
    sslEnabled: false,
    sslRejectUnauthorized: true,
    passwordSet: true,
  },
  redis: { enabled: false, builtIn: false, host: 'localhost', port: '6379', passwordSet: false },
  queue: { enabled: false },
  storage: {
    type: 'local',
    builtIn: false,
    localPath: './data/media',
    s3Bucket: '',
    s3Region: 'ap-southeast-1',
    s3Endpoint: '',
    s3CredentialsSet: false,
  },
  // headless: false deliberately differs from the component's useState default (true) — asserting
  // it reads false is what proves this field came from /config, not from the initial state.
  engine: {
    type: 'whatsapp-web.js',
    headless: false,
    sessionDataPath: '/data/custom-sessions',
    browserArgs: '--headless=new --custom-flag',
  },
};

const ENGINES: Engine[] = [
  {
    id: 'whatsapp-web.js',
    name: 'WhatsApp Web (Puppeteer)',
    enabled: true,
    features: [],
    library: { name: 'whatsapp-web.js', version: '1.34.7' },
  },
  { id: 'baileys', name: 'Baileys', enabled: true, features: [] },
];

const CURRENT_ENGINE = { engineType: 'whatsapp-web.js' };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

const fetchCalls: FetchCall[] = [];

function resetFetchCalls(): void {
  fetchCalls.length = 0;
}

function findFetchCall(method: string, path: string): FetchCall | undefined {
  return fetchCalls.find(c => c.method === method && c.path === path);
}

// URL router for every endpoint the page can hit. Anything else 404s loudly rather than resolving
// into a confusing downstream failure.
//
// ⚠️ /api/health/ready is NOT under /api/infra — routing it on an /api/infra prefix would 404 it
// and drop checkServerHealth into its up-to-60-attempt, 1s-interval poll. It is stubbed here for
// completeness even though none of the three cases below drive the restart flow far enough to hit it.
function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ method, path, body });

    if (method === 'GET' && path === '/api/infra/status') return Promise.resolve(jsonResponse(INFRA_STATUS));
    if (method === 'GET' && path === '/api/infra/config') return Promise.resolve(jsonResponse(SAVED_CONFIG));
    if (method === 'GET' && path === '/api/infra/engines') return Promise.resolve(jsonResponse(ENGINES));
    if (method === 'GET' && path === '/api/infra/engines/current') return Promise.resolve(jsonResponse(CURRENT_ENGINE));
    if (method === 'PUT' && path === '/api/infra/config') {
      return Promise.resolve(
        jsonResponse({ message: 'Configuration saved', saved: true, envPath: '.env.generated', profiles: [] }),
      );
    }
    if (method === 'POST' && path === '/api/infra/restart') {
      return Promise.resolve(
        jsonResponse({ message: 'restarting', restarting: true, profiles: [], profilesToRemove: [], estimatedTime: 5 }),
      );
    }
    if (method === 'GET' && path === '/api/health/ready') {
      return Promise.resolve(jsonResponse({ status: 'ok', details: {} }));
    }
    if (method === 'GET' && path === '/api/infra/export-data') {
      return Promise.resolve(
        jsonResponse({ exportedAt: new Date(0).toISOString(), dataDbType: 'postgres', tables: {}, counts: {} }),
      );
    }
    if (method === 'POST' && path === '/api/infra/import-data') {
      return Promise.resolve(jsonResponse({ imported: true, counts: {} }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

// ── DOM helpers ──────────────────────────────────────────────────────────────
// The page's labels are plain siblings of their inputs (no htmlFor/id, no wrapping) — the DB/Redis/
// Storage/Engine detail fields are NOT reachable via getByLabelText. These walk the same
// .form-group / .toggle-row structure the page renders instead.

function fieldInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('.form-group > label')).find(l => l.textContent === labelText);
  if (!label) throw new Error(`no field labeled "${labelText}"`);
  const input = label.parentElement?.querySelector('input');
  if (!input) throw new Error(`no input in the "${labelText}" field`);
  return input as HTMLInputElement;
}

function toggleInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const span = Array.from(container.querySelectorAll('.toggle-info > span')).find(s => s.textContent === labelText);
  if (!span) throw new Error(`no toggle labeled "${labelText}"`);
  const input = span.closest('.toggle-row')?.querySelector('input[type="checkbox"]');
  if (!input) throw new Error(`no checkbox for toggle "${labelText}"`);
  return input as HTMLInputElement;
}

// ── Harness bootstrap ────────────────────────────────────────────────────────

type RTL = typeof import('@testing-library/react');
type InfrastructureModule = typeof import('./Infrastructure.tsx');
type RoleModule = typeof import('../components/RoleProvider.tsx');
type ToastModule = typeof import('../components/Toast.tsx');

let rtl: RTL;
let Infrastructure: InfrastructureModule['Infrastructure'];
let RoleProvider: RoleModule['RoleProvider'];
let ToastProvider: ToastModule['ToastProvider'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  await import('../i18n/index.ts');
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Infrastructure } = await import('./Infrastructure.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderInfrastructure(): { container: HTMLElement } {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
}

// ── Smoke tests ──────────────────────────────────────────────────────────────

test('Infrastructure renders and the config form hydrates from /status and /config', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');

  await waitFor(() => {
    // dbConfig.type comes ONLY from /status (the live-seed effect) — sqlite is the useState default,
    // so a checked Postgres radio here proves /status actually hydrated the form.
    const dbRadios = container.querySelectorAll('input[name="dbType"]');
    assert.equal((dbRadios[1] as HTMLInputElement).checked, true, 'expected the Postgres radio to be selected');

    // These fields are written ONLY by the saved-config hydrate effect (never by the /status
    // effect), so they pin /config hydration specifically, without the host/port race.
    assert.equal(fieldInput(container, 'Username').value, 'openwa_admin');
    assert.equal(fieldInput(container, 'Database Name').value, 'openwa_prod');
    assert.equal(fieldInput(container, 'Schema').value, 'appschema');
    assert.equal(fieldInput(container, 'Pool Size').value, '7');

    // Engine detail fields are also /config-only; headless flips the useState default (true) to
    // false, so a false checkbox proves hydration rather than an untouched default.
    assert.equal(toggleInput(container, 'Headless Mode').checked, false);
    assert.equal(fieldInput(container, 'Session Data Path').value, '/data/custom-sessions');
    assert.equal(fieldInput(container, 'Browser Arguments').value, '--headless=new --custom-flag');
  });
});

test('editing a database field and saving PUTs the edited value in the request body', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  // Wait for the postgres detail form (and its Host field) to actually be present before editing it.
  await waitFor(() => assert.equal(fieldInput(container, 'Username').value, 'openwa_admin'));

  const hostInput = fieldInput(container, 'Host');
  fireEvent.change(hostInput, { target: { value: 'edited-host.example.com' } });
  assert.equal(hostInput.value, 'edited-host.example.com');

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  // The optimistic DOM value alone would pass even if the PUT body were wrong — assert the wire call.
  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { database?: { host?: string } };
    assert.equal(body.database?.host, 'edited-host.example.com');
  });
});

test('a successful save opens the restart modal', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  renderInfrastructure();

  await screen.findByText('Database Configuration');
  const saveButton = await screen.findByRole('button', { name: 'Save Configuration' });
  fireEvent.click(saveButton);

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected the save to have PUT /infra/config');
  });

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText('Configuration saved');
  // The idle restart state offers both actions; asserting the button exists (not clicking it) keeps
  // this test clear of handleRestart's uncancelled setInterval/setTimeout chain.
  within(dialog).getByRole('button', { name: 'Restart Now' });
  within(dialog).getByRole('button', { name: 'Restart Later' });
});
