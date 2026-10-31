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
import { readFileSync } from 'node:fs';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfraStatus, SavedConfig, Engine } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';
import {
  EXPECTED_MODE,
  FILE_STATES,
  HOST_SPELLINGS,
  PIN_STATES,
  SERVICES,
  pinnedHost,
  type PinState,
  type ServiceName,
} from '../../../test/fixtures/builtin-mode-cases.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

// The form is seeded from /config, and from /status only for the built-in flags and for a host, port or
// path nothing has saved. database.host is the same in both here, so the stock fixtures do not say which
// one supplied it: username, database name, schema and pool size, which only /config carries, are what
// prove /config hydration.
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
    builtInSet: true,
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
  redis: { enabled: false, builtIn: false, builtInSet: true, host: 'localhost', port: '6379', passwordSet: false },
  queue: { enabled: false },
  storage: {
    type: 'local',
    builtIn: false,
    builtInSet: true,
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

// Per-test fixture swaps for the three responses whose disagreement the engine-pin tests turn on
// (running engine vs saved engine vs whether ENGINE_TYPE is pinned). Reset in afterEach so the
// smoke tests above keep seeing the stock fixtures.
let overrides: {
  status?: InfraStatus;
  saved?: SavedConfig;
  // What /config reports once a save went through (the file that save wrote), when it differs from `saved`.
  savedAfterSave?: SavedConfig;
  savedAfterSaveFails?: boolean;
  savedFails?: boolean;
  statusFails?: boolean;
  currentEngine?: { engineType: string };
  restart?: () => Response;
  // The Docker profiles the save answers with, and a gate holding that answer back (a save in flight).
  saveProfiles?: string[];
  saveGate?: Promise<void>;
  readyFails?: boolean;
} = {};

// ENGINE_TYPE supplied by the container environment, so the dashboard cannot change it.
const PINNED_STATUS: InfraStatus = { ...INFRA_STATUS, envPinned: ['ENGINE_TYPE'] };

// The operator's saved choice, deliberately DIFFERENT from the running engine — that disagreement is
// the whole subject of these tests, and the stock fixtures agree on whatsapp-web.js.
const SAVED_BAILEYS: SavedConfig = { ...SAVED_CONFIG, engine: { ...SAVED_CONFIG.engine, type: 'baileys' } };

// Saved storage differs from the running one — the "saved, awaiting restart" state, with no pin.
const SAVED_STORAGE_DRIFT: SavedConfig = { ...SAVED_CONFIG, storage: { ...SAVED_CONFIG.storage, type: 's3' } };

const CONFIG_LOAD_ERROR = "Couldn't load the saved configuration, so it can't be edited here. Refresh to try again.";

const PENDING_RESTART_NOTE = 'Saved, but not applied yet — restart the server for this change to take effect.';

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

    if (method === 'GET' && path === '/api/infra/status') {
      if (overrides.statusFails) return Promise.resolve(jsonResponse({ message: 'Bad Gateway' }, 502));
      return Promise.resolve(jsonResponse(overrides.status ?? INFRA_STATUS));
    }
    if (method === 'GET' && path === '/api/infra/config') {
      if (overrides.savedFails) return Promise.resolve(jsonResponse({ message: 'boom' }, 500));
      if (overrides.savedAfterSaveFails && findFetchCall('PUT', '/api/infra/config')) {
        return Promise.resolve(jsonResponse({ message: 'boom' }, 500));
      }
      if (overrides.savedAfterSave && findFetchCall('PUT', '/api/infra/config')) {
        return Promise.resolve(jsonResponse(overrides.savedAfterSave));
      }
      return Promise.resolve(jsonResponse(overrides.saved ?? SAVED_CONFIG));
    }
    if (method === 'GET' && path === '/api/infra/engines') return Promise.resolve(jsonResponse(ENGINES));
    if (method === 'GET' && path === '/api/infra/engines/current')
      return Promise.resolve(jsonResponse(overrides.currentEngine ?? CURRENT_ENGINE));
    if (method === 'PUT' && path === '/api/infra/config') {
      const answer = () =>
        jsonResponse({
          message: 'Configuration saved',
          saved: true,
          envPath: '.env.generated',
          profiles: overrides.saveProfiles ?? [],
        });
      return overrides.saveGate ? overrides.saveGate.then(answer) : Promise.resolve(answer());
    }
    if (method === 'POST' && path === '/api/infra/restart') {
      if (overrides.restart) return Promise.resolve(overrides.restart());
      return Promise.resolve(
        jsonResponse({ message: 'restarting', restarting: true, profiles: [], profilesToRemove: [], estimatedTime: 5 }),
      );
    }
    if (method === 'GET' && path === '/api/health/ready') {
      if (overrides.readyFails) return Promise.resolve(jsonResponse({ status: 'error', details: {} }, 503));
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
  // Awaited, not just imported: catalogues are fetched now, so the import only starts the load and
  // the English copy these tests query by name renders as a raw key until it arrives.
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Infrastructure } = await import('./Infrastructure.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  overrides = {};
});

function renderInfrastructure() {
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
    // dbConfig.type is seeded from the saved config: sqlite is the useState default, so a checked
    // Postgres radio here proves the form was hydrated.
    const dbRadios = container.querySelectorAll('input[name="dbType"]');
    assert.equal((dbRadios[1] as HTMLInputElement).checked, true, 'expected the Postgres radio to be selected');

    // Only /config carries these fields, so they pin /config hydration specifically.
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

// An empty field saves the gateway's DEFAULT_PUPPETEER_ARGS, so the placeholder must name that list: an
// operator who copies a shorter one drops flags such as the /dev/shm crash guard.
test('the Browser Arguments placeholder is the default an empty field saves', async () => {
  const source = readFileSync(new URL('../../../src/config/configuration.ts', import.meta.url), 'utf8');
  const list = /DEFAULT_PUPPETEER_ARGS[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(list, 'DEFAULT_PUPPETEER_ARGS not found');
  const defaults = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]).join(' ');
  const { container } = renderInfrastructure();
  await rtl.screen.findByText('Database Configuration');
  assert.equal(fieldInput(container, 'Browser Arguments').placeholder, defaults);
});

// The detail fields (username, database, schema, bucket, engine options) come only from /config.
// Rendered without it, the form holds its built-in defaults, and a Save would write them over the
// stored external database, S3 and engine settings.
test('a failed /config read offers no Save, so defaults cannot overwrite the stored settings', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { savedFails: true };
  renderInfrastructure();

  await screen.findByText(CONFIG_LOAD_ERROR);
  assert.ok(!screen.queryByRole('button', { name: 'Save Configuration' }), 'Save offered without the saved config');
});

// The backup only reads the running database, so a missing saved config must not take it away.
test('a failed /config read names the config, and still offers the data backup export and import', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetFetchCalls();
  overrides = { savedFails: true };
  const { container } = renderInfrastructure();

  await screen.findByText(CONFIG_LOAD_ERROR);
  assert.ok(
    !screen.queryByText("Couldn't load the current infrastructure status. Refresh to try again."),
    'the status that did load is reported as failed',
  );
  assert.ok(container.querySelector('.data-migration-row input[type="file"]'), 'no backup import offered');
  fireEvent.click(screen.getByRole('button', { name: 'Export data' }));
  await waitFor(() => assert.ok(findFetchCall('GET', '/api/infra/export-data'), 'the backup export was not requested'));
});

test('the storage badge names local storage in the active language', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  renderInfrastructure();

  const card = (await screen.findByText('Storage Configuration')).closest('.infra-card') as HTMLElement;
  assert.equal(card.querySelector('.card-header .status-indicator')?.textContent, '● Local Filesystem');
});

/**
 * Every toggle is a bare checkbox inside a `<label class="toggle-switch">` whose only other child is
 * the decorative slider span, so the wrapping label contributes no text: a screen reader announced
 * anonymous checkboxes on this page. The visible caption lives in a sibling `.toggle-info > span`,
 * which each checkbox now references with aria-labelledby.
 *
 * This proves the reference actually resolves to text in a real DOM. It covers only the four toggles
 * this fixture renders (SSL, built-in Redis and the rest sit behind other toggles); a11y-controls
 * covers the rest of them, and every other page, structurally.
 */
test('every rendered toggle exposes an accessible name from its visible caption', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();
  await screen.findByText('Database Configuration');

  const toggles = Array.from(container.querySelectorAll('label.toggle-switch input[type="checkbox"]'));
  // Guards against a vacuous pass if the page ever stops rendering toggles under this fixture.
  assert.ok(toggles.length >= 4, `expected the open sections to render toggles, found ${toggles.length}`);

  const unnamed = toggles
    .map(input => {
      const id = input.getAttribute('aria-labelledby');
      const name = id ? (container.querySelector(`#${id}`)?.textContent ?? '').trim() : '';
      return { id, name };
    })
    .filter(t => !t.name)
    .map(t => t.id ?? '(no aria-labelledby)');

  // Named, not counted: a failure has to say WHICH toggle lost its caption.
  assert.deepEqual(unnamed, [], `toggles with no accessible name: ${unnamed.join(', ')}`);
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

// Clearing the number input to type a new size leaves NaN, which JSON writes as null, and the gateway
// refuses the whole save for it.
test('a save with the pool size cleared leaves the size out instead of sending null', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const poolSize = fieldInput(container, 'Pool Size');
  fireEvent.change(poolSize, { target: { value: '' } });
  assert.equal(poolSize.value, '');
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const database = (call!.body as { database: Record<string, unknown> }).database;
    assert.ok(!('poolSize' in database), `poolSize went out as ${JSON.stringify(database.poolSize)}`);
  });
});

test('a pool size typed outside the 1 to 50 the field offers is kept inside it', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const poolSize = fieldInput(container, 'Pool Size');

  fireEvent.change(poolSize, { target: { value: '100' } });
  assert.equal(poolSize.value, '50');
  fireEvent.change(poolSize, { target: { value: '0' } });
  assert.equal(poolSize.value, '1');
  fireEvent.change(poolSize, { target: { value: '25' } });
  assert.equal(poolSize.value, '25');
});

test('a password typed before switching to a built-in container is not saved', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await waitFor(() => assert.equal(fieldInput(container, 'Username').value, 'openwa_admin'));

  // Typed while external, then the field is hidden by the built-in toggle but its state survives.
  fireEvent.change(container.querySelector('#infra-4')!, { target: { value: 'typed-db-secret' } });
  fireEvent.click(toggleInput(container, 'Use Built-in PostgreSQL Container'));

  fireEvent.click(toggleInput(container, 'Enable Redis'));
  fireEvent.change(container.querySelector('#infra-12')!, { target: { value: 'typed-redis-secret' } });
  fireEvent.click(toggleInput(container, 'Use Built-in Redis Container'));

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  // The bundled containers never receive a typed password, so '' (unchanged) is what must be sent.
  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as {
      database?: { builtIn?: boolean; password?: string };
      redis?: { builtIn?: boolean; password?: string };
    };
    assert.equal(body.database?.builtIn, true);
    assert.equal(body.database?.password, '');
    assert.equal(body.redis?.builtIn, true);
    assert.equal(body.redis?.password, '');
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
  // The idle restart state offers both actions; the click-through (and its timer cleanup on
  // unmount) is covered by the last test in this file.
  within(dialog).getByRole('button', { name: 'Restart Now' });
  within(dialog).getByRole('button', { name: 'Restart Later' });
});

const DB_SWITCH_WARNING = 'The new database starts empty.';

test('an external Postgres on the default host, port and name does not warn of a switch on save', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  // Nothing saved for the three keys (the environment supplies them, or they are left at the defaults):
  // /config reports '', while the form shows the host from /status and the defaults 5432 and openwa.
  overrides = {
    saved: { ...SAVED_CONFIG, database: { ...SAVED_CONFIG.database, host: '', port: '', database: '' } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText('Configuration saved');
  assert.ok(!within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }), 'an unchanged database is no switch');
});

const STATUS_LOAD_ERROR = "Couldn't load the current infrastructure status. Refresh to try again.";

test('a failed first /status read shows the status error card and no form', async () => {
  overrides = { statusFails: true };
  renderInfrastructure();

  await rtl.screen.findByText(STATUS_LOAD_ERROR);
  assert.equal(rtl.screen.queryByRole('button', { name: 'Save Configuration' }) === null, true);
});

test('a failed background /status refetch keeps the form and the restart modal on screen', async () => {
  const { screen, fireEvent } = rtl;
  renderInfrastructure();

  fireEvent.click(await screen.findByRole('button', { name: 'Save Configuration' }));
  await screen.findByRole('dialog');

  // A focus refetch while the gateway is down: the cached status is still there, only the read failed.
  overrides = { statusFails: true };
  await queryClient!.refetchQueries({ queryKey: ['infra', 'status'] });
  assert.equal(queryClient!.getQueryState(['infra', 'status'])?.status, 'error');
  // Let the error state render before looking.
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.ok(screen.queryByRole('dialog'), 'the restart modal must stay open');
  assert.equal(screen.queryByText(STATUS_LOAD_ERROR) === null, true);
  screen.getByRole('button', { name: 'Save Configuration' });
});

// ── The engine radio's seed source (#1082) ───────────────────────────────────
// ENGINES fixture order fixes the radio order: [0] whatsapp-web.js, [1] baileys.

function engineRadios(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[name="engineType"]'));
}

// Waits for the form to be seeded, which happens once both reads are in. Uses a DATABASE field on
// purpose: the engine detail fields render only for whatsapp-web.js, so waiting on one of those would
// vanish the moment a test seeds the radio to baileys.
async function awaitConfigHydrated(container: HTMLElement): Promise<void> {
  await rtl.waitFor(() => assert.equal(fieldInput(container, 'Username').value, 'openwa_admin'));
}

test('the engine radio seeds from the saved engine even when nothing pins ENGINE_TYPE', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  // Running and saved disagree with no pin at all — the ordinary "saved but not restarted yet" state.
  // The running engine is stale here (the gateway resolves ENGINE_TYPE once at boot), so seeding from
  // it would show an engine nobody currently wants and write it back on the next save.
  overrides = { saved: SAVED_BAILEYS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  await waitFor(() =>
    assert.equal(engineRadios(container)[1].checked, true, 'expected the saved engine (baileys) to be selected'),
  );
});

test('saving after an unrestarted engine change does not write the running engine back', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  // No pin anywhere. The operator changed the engine earlier and has not restarted, so /engines/current
  // still reports the old one. Saving an unrelated field must not resurrect it over the saved choice.
  overrides = { saved: SAVED_BAILEYS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { engine?: { type?: string } };
    assert.equal(body.engine?.type, 'baileys');
  });
});

test('an operator selection wins over the seed and is what gets saved', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  // Guards the #735 invariant through the seeding rewrite: whatever the seed chose, a click owns the
  // field afterwards and the payload must carry the click.
  fireEvent.click(engineRadios(container)[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { engine?: { type?: string } };
    assert.equal(body.engine?.type, 'baileys');
  });
});

// ── A switch saved and not restarted for ─────────────────────────────────────
// The operator saved PostgreSQL, Redis with the queue, and S3, chose Restart Later, and reloaded: the
// gateway still runs SQLite, local media and no Redis. The form is the saved choice (a save of anything
// else must not write the running one back over it); the card badges report what runs.

const RUNNING_SQLITE: InfraStatus = {
  ...INFRA_STATUS,
  database: { connected: true, type: 'sqlite', host: 'localhost', builtIn: false },
};
const SAVED_SWITCH: SavedConfig = {
  ...SAVED_CONFIG,
  redis: { enabled: true, builtIn: false, builtInSet: true, host: 'redis.internal', port: '6380', passwordSet: true },
  queue: { enabled: true },
  storage: { ...SAVED_CONFIG.storage, type: 's3', s3Bucket: 'media', s3CredentialsSet: true },
};

// The saved headless flag is false and the useState default is true, so it reads false only once the form is seeded.
async function awaitSeeded(container: HTMLElement): Promise<void> {
  await rtl.waitFor(() => assert.equal(toggleInput(container, 'Headless Mode').checked, false));
}

function cardBadge(container: HTMLElement, heading: string): string | null | undefined {
  const card = Array.from(container.querySelectorAll('.infra-card')).find(
    c => c.querySelector('h2')?.textContent === heading,
  );
  return card?.querySelector('.card-header .status-indicator')?.textContent;
}

test('saving an unrelated field after a reload keeps a switch that was saved and is waiting for a restart', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_SQLITE, saved: SAVED_SWITCH };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  // The stored headless flag is false; flipping it is the only edit.
  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as {
      database?: { type?: string };
      redis?: { enabled?: boolean };
      queue?: { enabled?: boolean };
      storage?: { type?: string };
      engine?: { headless?: boolean };
    };
    assert.deepEqual(
      {
        database: body.database?.type,
        redis: body.redis?.enabled,
        queue: body.queue?.enabled,
        storage: body.storage?.type,
        headless: body.engine?.headless,
      },
      { database: 'postgres', redis: true, queue: true, storage: 's3', headless: true },
    );
  });
});

test('the card badges report what runs while the form shows what was saved', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_SQLITE, saved: SAVED_SWITCH };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(cardBadge(container, 'Database Configuration'), '● SQLite');
  assert.equal(cardBadge(container, 'Redis'), '● Disabled');
  assert.equal(cardBadge(container, 'Storage Configuration'), '● Local Filesystem');
  const selected = (name: string) =>
    container.querySelector(`input[name="${name}"]:checked`)?.closest('label')?.querySelector('span')?.textContent;
  assert.equal(selected('dbType'), 'PostgreSQL');
  assert.equal(toggleInput(container, 'Enable Redis').checked, true);
  assert.equal(selected('storageType'), 'Amazon S3');
});

test('a queue switch saved and left for a restart shows the pending-restart note', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  // Redis already runs, so the only difference between running and saved is the queue.
  overrides = {
    status: {
      ...INFRA_STATUS,
      redis: { enabled: true, connected: true, host: 'redis.internal', port: 6380, builtIn: false },
    },
    saved: { ...SAVED_CONFIG, redis: { ...SAVED_SWITCH.redis }, queue: { enabled: true } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  const queueRow = toggleInput(container, 'Enable BullMQ Queue System').closest('.toggle-row');
  assert.equal(queueRow?.nextElementSibling?.textContent?.trim(), PENDING_RESTART_NOTE);
  assert.equal(screen.getAllByText(PENDING_RESTART_NOTE).length, 1, 'the note belongs to the queue alone');
});

// ── A built-in switch saved and not restarted for ────────────────────────────
// Same service, other mode: the type is unchanged, so only the Use Built-in toggle differs from what runs.

const STORAGE_WARNING = 'Existing media files are not moved to the new storage backend';

const RUNNING_EXTERNAL: InfraStatus = {
  ...INFRA_STATUS,
  storage: { type: 's3', bucket: 'media', builtIn: false, s3Available: true },
};
const SAVED_BUNDLED: SavedConfig = {
  ...SAVED_CONFIG,
  database: { ...SAVED_CONFIG.database, builtIn: true },
  storage: { ...SAVED_CONFIG.storage, type: 's3', builtIn: true },
};
// The bundled containers the dashboard created, running and backing their services.
const RUNNING_BUNDLED: InfraStatus = {
  ...INFRA_STATUS,
  database: { connected: true, type: 'postgres', host: 'postgres', builtIn: true, running: true },
  redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true, running: true },
  storage: {
    type: 's3',
    bucket: 'openwa',
    endpoint: 'http://minio:9000',
    builtIn: true,
    running: true,
    s3Available: true,
  },
};
const SAVED_EXTERNAL: SavedConfig = {
  ...SAVED_CONFIG,
  redis: { enabled: true, builtIn: false, builtInSet: true, host: 'redis.internal', port: '6379', passwordSet: false },
  storage: { ...SAVED_CONFIG.storage, type: 's3', builtIn: false },
};

test('the built-in toggles show what was saved, and a later save warns of the switch it applies', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_EXTERNAL, saved: SAVED_BUNDLED };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  assert.equal(toggleInput(container, 'Use Built-in PostgreSQL Container').checked, true);
  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, true);

  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
  within(dialog).getByText(STORAGE_WARNING, { exact: false });
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database?: { builtIn?: boolean };
    storage?: { builtIn?: boolean };
  };
  assert.deepEqual([body.database?.builtIn, body.storage?.builtIn], [true, true]);
});

test('a switch from bundled to external services is warned of and stops the bundled containers', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_BUNDLED, saved: SAVED_EXTERNAL };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  assert.equal(toggleInput(container, 'Use Built-in PostgreSQL Container').checked, false);
  assert.equal(toggleInput(container, 'Use Built-in Redis Container').checked, false);
  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, false);

  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database?: { builtIn?: boolean };
    redis?: { builtIn?: boolean };
    storage?: { builtIn?: boolean };
  };
  assert.deepEqual([body.database?.builtIn, body.redis?.builtIn, body.storage?.builtIn], [false, false, false]);

  within(dialog).getByText(STOPS_SENTENCE, { exact: false });
  assert.deepEqual(stopNames(dialog), ALL_THREE);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, {
    profiles: [],
    profilesToRemove: ['postgres', 'redis', 'minio'],
  });
});

const STOPS_SENTENCE = 'The restart also stops these built-in containers, which keep their data and are not deleted:';
const ALL_THREE = ['openwa-postgres', 'openwa-redis', 'openwa-minio'];

// The containers the restart dialog names, one chip each.
function stopNames(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll('.restart-stop-name')).map(chip => chip.textContent ?? '');
}

const PENDING_BUILT_IN_NOTE =
  'Saved, but not applied yet: the server runs with an external service now, and a restart switches it to the built-in container.';
const PENDING_EXTERNAL_NOTE =
  'Saved, but not applied yet: the server runs with the built-in container now, and a restart switches it to an external service.';

// The note sits under the toggle it explains and names what runs, since the toggle shows what was saved.
function toggleNote(container: HTMLElement, labelText: string): string | undefined {
  return toggleInput(container, labelText).closest('.toggle-row')?.nextElementSibling?.textContent?.trim();
}

test('a switch to a bundled container waiting for a restart says what runs now, under each toggle', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  // External services run on all three cards, and the bundled containers are what was saved.
  overrides = {
    status: {
      ...RUNNING_EXTERNAL,
      redis: { enabled: true, connected: true, host: 'redis.internal', port: 6379, builtIn: false },
    },
    saved: {
      ...SAVED_BUNDLED,
      redis: { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(toggleNote(container, 'Use Built-in PostgreSQL Container'), PENDING_BUILT_IN_NOTE);
  assert.equal(toggleNote(container, 'Use Built-in Redis Container'), PENDING_BUILT_IN_NOTE);
  assert.equal(toggleNote(container, 'Use Built-in MinIO Container'), PENDING_BUILT_IN_NOTE);
});

test('a switch to external services waiting for a restart says what runs now, under each toggle', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_BUNDLED, saved: SAVED_EXTERNAL };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(toggleNote(container, 'Use Built-in PostgreSQL Container'), PENDING_EXTERNAL_NOTE);
  assert.equal(toggleNote(container, 'Use Built-in Redis Container'), PENDING_EXTERNAL_NOTE);
  assert.equal(toggleNote(container, 'Use Built-in MinIO Container'), PENDING_EXTERNAL_NOTE);
});

test('no built-in note while the toggles agree with what runs', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = {
    status: RUNNING_BUNDLED,
    saved: { ...SAVED_EXTERNAL, database: { ...SAVED_EXTERNAL.database, builtIn: true } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  // Only PostgreSQL agrees (bundled on both sides); Redis and MinIO still differ.
  assert.equal(screen.queryAllByText(PENDING_EXTERNAL_NOTE).length, 2);
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a note beside a toggle that agrees');
});

// The documented .env route: DATABASE_HOST=postgres, REDIS_HOST=redis and S3_ENDPOINT are pinned and compose never
// forwards the flags, so /config holds none and only /status knows the bundled containers run. Nothing was saved, so
// no toggle, note or warning may claim a switch, and a save must keep sending the running mode.
const UNSTORED_BUILT_IN: SavedConfig = {
  ...SAVED_EXTERNAL,
  database: { ...SAVED_EXTERNAL.database, builtIn: false, builtInSet: false },
  redis: { ...SAVED_EXTERNAL.redis, builtIn: false, builtInSet: false },
  storage: { ...SAVED_EXTERNAL.storage, builtIn: false, builtInSet: false },
};

test('bundled containers running with no flag stored show the toggles on and claim no switch', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: RUNNING_BUNDLED,
    saved: UNSTORED_BUILT_IN,
    // What the gateway answers for bundled flags: the profiles of the containers that stay.
    saveProfiles: ['postgres', 'redis', 'minio'],
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  assert.equal(toggleInput(container, 'Use Built-in PostgreSQL Container').checked, true);
  assert.equal(toggleInput(container, 'Use Built-in Redis Container').checked, true);
  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, true);
  assert.equal(screen.queryByText(PENDING_EXTERNAL_NOTE) === null, true, 'a switch claimed with nothing saved');
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a switch claimed with nothing saved');

  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.equal(within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }) === null, true, 'a warning, no switch');
  assert.equal(within(dialog).queryByText(STORAGE_WARNING, { exact: false }) === null, true, 'a warning, no switch');
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database?: { builtIn?: boolean };
    redis?: { builtIn?: boolean };
    storage?: { builtIn?: boolean };
  };
  assert.deepEqual([body.database?.builtIn, body.redis?.builtIn, body.storage?.builtIn], [true, true, true]);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, {
    profiles: ['postgres', 'redis', 'minio'],
    profilesToRemove: [],
  });
});

// The flag note is a claim about one service, so it needs that same service saved and running.
test('no built-in note under Redis that is saved but not enabled yet', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = {
    saved: {
      ...SAVED_CONFIG,
      redis: { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(toggleInput(container, 'Use Built-in Redis Container').checked, true);
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a flag note for a Redis that is not running');
  assert.equal(screen.queryByText(PENDING_EXTERNAL_NOTE) === null, true, 'a flag note for a Redis that is not running');
});

test('no built-in note under S3 storage that is saved but not running yet', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { saved: { ...SAVED_CONFIG, storage: { ...SAVED_CONFIG.storage, type: 's3', builtIn: true } } };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, true);
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a flag note for a storage not running');
  assert.equal(screen.queryByText(PENDING_EXTERNAL_NOTE) === null, true, 'a flag note for a storage not running');
});

// The other half of the same guard: the service runs, but the saved config does not use it. Selecting it in the form
// then shows its Use Built-in toggle, and the note under it would claim a switch for a service nothing saved.
test('no built-in note for a Redis the saved config has disabled, once it is enabled in the form', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  overrides = {
    status: { ...INFRA_STATUS, redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true } },
    saved: {
      ...SAVED_CONFIG,
      redis: { enabled: false, builtIn: false, builtInSet: true, host: 'redis', port: '6379', passwordSet: false },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Enable Redis'));

  assert.equal(toggleInput(container, 'Use Built-in Redis Container').checked, false);
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a flag note for a Redis nothing saved');
  assert.equal(screen.queryByText(PENDING_EXTERNAL_NOTE) === null, true, 'a flag note for a Redis nothing saved');
});

test('no built-in note for a storage the saved config keeps local, once S3 is chosen in the form', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  overrides = {
    status: { ...INFRA_STATUS, storage: { type: 's3', bucket: 'openwa', builtIn: true, s3Available: true } },
    saved: { ...SAVED_CONFIG, storage: { ...SAVED_CONFIG.storage, type: 'local', builtIn: false, builtInSet: true } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="storageType"]')[1]);

  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, false);
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a flag note for a storage nothing saved');
  assert.equal(screen.queryByText(PENDING_EXTERNAL_NOTE) === null, true, 'a flag note for a storage nothing saved');
});

test('no built-in note for a database the saved config keeps on SQLite, once PostgreSQL is chosen in the form', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  overrides = {
    status: { ...INFRA_STATUS, database: { connected: true, type: 'postgres', host: 'postgres', builtIn: true } },
    saved: {
      ...SAVED_CONFIG,
      database: { ...SAVED_CONFIG.database, type: 'sqlite', builtIn: false, builtInSet: true },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="dbType"]')[1]);

  assert.equal(toggleInput(container, 'Use Built-in PostgreSQL Container').checked, false);
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a flag note for a database nothing saved');
  assert.equal(screen.queryByText(PENDING_EXTERNAL_NOTE) === null, true, 'a flag note for a database nothing saved');
});

test('the built-in notes are hidden while a save is in flight and back once it settles', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetFetchCalls();
  let release!: () => void;
  overrides = {
    status: RUNNING_EXTERNAL,
    saved: SAVED_BUNDLED,
    saveGate: new Promise<void>(resolve => (release = resolve)),
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  assert.equal(screen.queryAllByText(PENDING_BUILT_IN_NOTE).length, 2);

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  await waitFor(() => assert.ok(findFetchCall('PUT', '/api/infra/config'), 'expected the save request'));
  assert.equal(screen.queryAllByText(PENDING_BUILT_IN_NOTE).length, 0, 'a note stayed on screen during the save');

  release();
  await screen.findByRole('dialog');
  await waitFor(() => assert.equal(screen.queryAllByText(PENDING_BUILT_IN_NOTE).length, 2));
});

// ── The data-backend warning compares where the next boot connects with where the server connects now ──
// Whether a bundled container runs right now says nothing about that: a stopped or removed one is started again
// on the same host and the same named volume, so nothing starts empty.

const RUNNING_STOPPED: InfraStatus = {
  ...INFRA_STATUS,
  database: { connected: false, type: 'postgres', host: 'postgres', builtIn: false },
  storage: { type: 's3', bucket: 'openwa', endpoint: 'http://minio:9000', builtIn: false, s3Available: false },
};
const SAVED_BUNDLED_HOSTS: SavedConfig = {
  ...SAVED_CONFIG,
  database: { ...SAVED_CONFIG.database, host: 'postgres', builtIn: true, builtInSet: true },
  storage: {
    ...SAVED_CONFIG.storage,
    type: 's3',
    builtIn: true,
    builtInSet: true,
    s3Bucket: 'openwa',
    s3Endpoint: 'http://minio:9000',
  },
};

test('a saved built-in database and storage whose containers are stopped warn of no switch', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_STOPPED, saved: SAVED_BUNDLED_HOSTS, saveProfiles: ['postgres', 'minio'] };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.equal(within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }) === null, true, 'database warning');
  assert.equal(within(dialog).queryByText(STORAGE_WARNING, { exact: false }) === null, true, 'storage warning');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, {
    profiles: ['postgres', 'minio'],
    profilesToRemove: [],
  });
});

// The note names what runs, and with the bundled host dialled and the container stopped that is still the built-in
// container, which the restart starts again.
test('a saved built-in database and storage whose containers are stopped claim no switch under the toggle', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_STOPPED, saved: SAVED_BUNDLED_HOSTS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(toggleInput(container, 'Use Built-in PostgreSQL Container').checked, true);
  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, true);
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a switch claimed for a stopped container');
});

test('moving off a stopped bundled database and storage still warns of the switch', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_STOPPED, saved: SAVED_BUNDLED_HOSTS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Use Built-in PostgreSQL Container'));
  fireEvent.change(fieldInput(container, 'Host'), { target: { value: 'db.new.example' } });
  fireEvent.click(toggleInput(container, 'Use Built-in MinIO Container'));
  fireEvent.change(fieldInput(container, 'Custom Endpoint (optional)'), {
    target: { value: 'https://s3.new.example' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
  within(dialog).getByText(STORAGE_WARNING, { exact: false });
});

// An external store moved to another bucket or endpoint leaves the media behind just like a backend change.
test('repointing external S3 storage to another bucket warns that the media stays behind', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      storage: { type: 's3', bucket: 'media', endpoint: 'https://s3.example', builtIn: false, s3Available: true },
    },
    saved: {
      ...SAVED_CONFIG,
      storage: { ...SAVED_CONFIG.storage, type: 's3', s3Bucket: 'media', s3Endpoint: 'https://s3.example' },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.change(fieldInput(container, 'Bucket Name'), { target: { value: 'media-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  within(await screen.findByRole('dialog')).getByText(STORAGE_WARNING, { exact: false });
});

// The gateway reports no bucket when none is set, and the store then uses its default one.
test('S3 storage on the default bucket warns of nothing on an unrelated save', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      storage: { type: 's3', endpoint: 'https://s3.example', builtIn: false, s3Available: true },
    },
    saved: { ...SAVED_CONFIG, storage: { ...SAVED_CONFIG.storage, type: 's3', s3Endpoint: 'https://s3.example' } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.equal(within(dialog).queryByText(STORAGE_WARNING, { exact: false }) === null, true, 'storage warning');
});

test('pointing an external PostgreSQL at another database name warns of the switch', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.change(fieldInput(container, 'Database Name'), { target: { value: 'openwa_other' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  within(await screen.findByRole('dialog')).getByText(DB_SWITCH_WARNING, { exact: false });
});

// A pinned type outranks the radio the same way a pinned host outranks the toggle.
test('changing a database or storage type the environment pins warns of no switch', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      storage: { type: 's3', bucket: 'media', endpoint: 'https://s3.example', builtIn: false, s3Available: true },
      envPinned: ['DATABASE_TYPE', 'STORAGE_TYPE'],
    },
    saved: {
      ...SAVED_CONFIG,
      storage: { ...SAVED_CONFIG.storage, type: 's3', s3Bucket: 'media', s3Endpoint: 'https://s3.example' },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="dbType"]')[0]);
  fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="storageType"]')[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.equal(within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }) === null, true, 'database warning');
  assert.equal(within(dialog).queryByText(STORAGE_WARNING, { exact: false }) === null, true, 'storage warning');
});

// Beside a pinned bundled endpoint the toggle reads on from what runs, but the save leaves the flag out and the
// gateway keeps the stored bucket, so an unrelated save moves no media.
test('an unrelated save beside a pinned bundled endpoint warns of no storage switch', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      storage: { type: 's3', bucket: 'media', endpoint: 'http://minio:9000', builtIn: true, s3Available: true },
      envPinned: ['S3_ENDPOINT'],
    },
    saved: {
      ...SAVED_CONFIG,
      storage: {
        ...SAVED_CONFIG.storage,
        type: 's3',
        builtIn: true,
        builtInSet: false,
        s3Bucket: 'media',
        s3Endpoint: 'http://minio:9000',
      },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, true);
  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.equal(within(dialog).queryByText(STORAGE_WARNING, { exact: false }) === null, true, 'storage warning');
});

// A pinned external host outranks the toggle, so turning Use Built-in on moves nothing but the database name the
// built-in save writes, openwa: with that name already in use nothing moves, with one of its own the database does.
for (const { name, moves } of [
  { name: 'openwa', moves: false },
  { name: 'openwa_prod', moves: true },
]) {
  test(`turning Use Built-in on under a pinned external host over database ${name} ${moves ? 'warns of the database' : 'warns of no switch'}`, async () => {
    const { screen, fireEvent, within } = rtl;
    resetFetchCalls();
    overrides = {
      status: {
        ...INFRA_STATUS,
        database: { connected: true, type: 'postgres', host: 'db.external.example', builtIn: false },
        storage: { type: 's3', bucket: 'openwa', endpoint: 'https://s3.example', builtIn: false, s3Available: true },
        envPinned: ['DATABASE_HOST', 'S3_ENDPOINT'],
      },
      saved: {
        ...SAVED_CONFIG,
        database: {
          ...SAVED_CONFIG.database,
          host: 'db.external.example',
          database: name,
          builtIn: false,
          builtInSet: false,
        },
        storage: {
          ...SAVED_CONFIG.storage,
          type: 's3',
          builtIn: false,
          builtInSet: false,
          s3Bucket: 'openwa',
          s3Endpoint: 'https://s3.example',
        },
      },
    };
    const { container } = renderInfrastructure();

    await screen.findByText('Database Configuration');
    await awaitSeeded(container);
    fireEvent.click(toggleInput(container, 'Use Built-in PostgreSQL Container'));
    fireEvent.click(toggleInput(container, 'Use Built-in MinIO Container'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

    const dialog = await screen.findByRole('dialog');
    assert.equal(within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }) !== null, moves, 'database warning');
    assert.equal(within(dialog).queryByText(STORAGE_WARNING, { exact: false }) === null, true, 'storage warning');
  });
}

// The host is compared as the save writes it, trimmed and with the default for an empty field.
test('a host typed with spaces around it is no switch', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.change(fieldInput(container, 'Host'), { target: { value: '  shared-db-host ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.equal(within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }) === null, true, 'database warning');
});

// A built-in choice saves the bundled port and database name, so values typed in the hidden external fields are
// not where the next boot connects.
test('external values typed and then hidden by a running built-in database are no switch', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: RUNNING_BUNDLED,
    saved: {
      ...SAVED_CONFIG,
      database: { ...SAVED_CONFIG.database, host: 'postgres', builtIn: true, builtInSet: true },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Use Built-in PostgreSQL Container'));
  fireEvent.change(fieldInput(container, 'Port'), { target: { value: '6000' } });
  fireEvent.change(fieldInput(container, 'Database Name'), { target: { value: 'other' } });
  fireEvent.click(toggleInput(container, 'Use Built-in PostgreSQL Container'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.equal(within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }) === null, true, 'database warning');
});

// SQLite runs and bundled PostgreSQL is saved: the database note names the type change, and a running
// "external" flag would be a claim about a database that is not running.
test('no built-in note beside a pending database type', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = {
    status: RUNNING_SQLITE,
    saved: { ...SAVED_CONFIG, database: { ...SAVED_CONFIG.database, builtIn: true } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a flag note beside a pending type');
  assert.equal(screen.queryByText(PENDING_EXTERNAL_NOTE) === null, true, 'a flag note beside a pending type');
  screen.getByText(PENDING_RESTART_NOTE);
});

// ── One rule for every saved and pinned state ────────────────────────────────
// GET /config answers the saved built-in mode (builtIn, builtInSet) from the file and the environment pins; the
// table in test/fixtures/builtin-mode-cases.ts is what the controller specs assert it against. Here every one of
// those answers is rendered into the page with each state /status can report beside it: the bundled container
// running, an external service, or the bundled host the server dials with its container stopped. A pinned
// bundled host runs the container or finds it stopped, and a pinned external host runs neither. The page follows
// the saved mode when builtInSet says one is saved and what runs otherwise, so the toggle, the pending note under
// it and the flag the save sends come from the same shown mode, and the data-backend warning from where the next
// boot connects against where the server connects now. The three services are given different combinations in
// each render, so one reading another's flag or answer shows up.

type RunState = 'bundled' | 'external' | 'stopped';
const RUN_STATES: Record<PinState, RunState[]> = {
  none: ['bundled', 'external', 'stopped'],
  bundled: ['bundled', 'stopped'],
  external: ['external'],
};
const COMBOS = FILE_STATES.flatMap(file =>
  PIN_STATES.flatMap(pin => RUN_STATES[pin].map(run => ({ file, pin, run, mode: EXPECTED_MODE[file][pin] }))),
);
type Combo = (typeof COMBOS)[number];
const comboLabel = (c: Combo) => `${c.file}/${c.pin}/${c.run}`;
const containerRuns = (c: Combo) => c.run === 'bundled';
const shownMode = (c: Combo) => (c.mode.builtInSet ? c.mode.builtIn : containerRuns(c));
// The host the server connects to now: the bundled one unless an external service runs.
const statusHost = (service: ServiceName, c: Combo) =>
  c.run === 'external' ? SERVICES[service].externalHost : SERVICES[service].bundledHost;
// The host the saved config names: a pin decides it; otherwise a file that holds the bundled host names that one,
// and any other an external service.
const savedHost = (service: ServiceName, c: Combo) =>
  pinnedHost(service, c.pin) ??
  (c.file === 'bundled-host' || c.file === 'saved-bundled'
    ? SERVICES[service].bundledHost
    : SERVICES[service].externalHost);
// The next boot connects to a pinned host whatever the toggle says, to the bundled one for a built-in choice, and
// to the saved one otherwise.
const nextHost = (service: ServiceName, c: Combo) =>
  c.pin === 'none' && shownMode(c) ? SERVICES[service].bundledHost : savedHost(service, c);
const bucketFor = (service: ServiceName, host: string) => (host === SERVICES[service].bundledHost ? 'openwa' : 'media');

/** The notes rendered right under a toggle row, in order. */
function notesUnderToggle(container: HTMLElement, labelText: string): string[] {
  const notes: string[] = [];
  let next = toggleInput(container, labelText).closest('.toggle-row')?.nextElementSibling;
  while (next?.classList.contains('env-pin-note')) {
    notes.push(next.textContent?.trim() ?? '');
    next = next.nextElementSibling;
  }
  return notes;
}

const ENV_PIN_NOTE = /^Pinned by the environment variable ([A-Z][A-Z0-9_]*)/;

function builtInNoteOf(container: HTMLElement, labelText: string): string | null {
  return notesUnderToggle(container, labelText).find(note => !ENV_PIN_NOTE.test(note)) ?? null;
}

/** The variable the pin note under a toggle names, or null when there is none. */
function hostPinNoteOf(container: HTMLElement, labelText: string): string | null {
  for (const note of notesUnderToggle(container, labelText)) {
    const name = ENV_PIN_NOTE.exec(note)?.[1];
    if (name) return name;
  }
  return null;
}

COMBOS.forEach((_, i) => {
  const database = COMBOS[i];
  const redis = COMBOS[(i + 7) % COMBOS.length];
  const storage = COMBOS[(i + 13) % COMBOS.length];
  test(`the built-in toggles, notes and warnings follow one rule: database ${comboLabel(database)}, redis ${comboLabel(redis)}, storage ${comboLabel(storage)}`, async () => {
    const { screen, fireEvent, within } = rtl;
    resetFetchCalls();
    overrides = {
      status: {
        ...INFRA_STATUS,
        database: {
          connected: true,
          type: 'postgres',
          host: statusHost('database', database),
          builtIn: containerRuns(database),
        },
        redis: {
          enabled: true,
          connected: true,
          host: statusHost('redis', redis),
          port: 6379,
          builtIn: containerRuns(redis),
        },
        storage: {
          type: 's3',
          bucket: bucketFor('storage', statusHost('storage', storage)),
          endpoint: statusHost('storage', storage),
          builtIn: containerRuns(storage),
          s3Available: true,
        },
        // A pinned host is reported, so the page can say why its toggle cannot take effect.
        envPinned: [
          database.pin !== 'none' && 'DATABASE_HOST',
          redis.pin !== 'none' && 'REDIS_HOST',
          storage.pin !== 'none' && 'S3_ENDPOINT',
        ].filter((key): key is string => typeof key === 'string'),
      },
      saved: {
        ...SAVED_CONFIG,
        database: { ...SAVED_CONFIG.database, host: savedHost('database', database), ...database.mode },
        redis: { enabled: true, host: savedHost('redis', redis), port: '6379', passwordSet: false, ...redis.mode },
        storage: {
          ...SAVED_CONFIG.storage,
          type: 's3',
          s3Bucket: bucketFor('storage', savedHost('storage', storage)),
          s3Endpoint: savedHost('storage', storage),
          ...storage.mode,
        },
      },
    };
    const { container } = renderInfrastructure();

    await screen.findByText('Database Configuration');
    await awaitSeeded(container);

    const rows = [
      { combo: database, label: 'Use Built-in PostgreSQL Container', hostKey: 'DATABASE_HOST' },
      { combo: redis, label: 'Use Built-in Redis Container', hostKey: 'REDIS_HOST' },
      { combo: storage, label: 'Use Built-in MinIO Container', hostKey: 'S3_ENDPOINT' },
    ];
    // A saved built-in choice switches nothing while the server already dials the bundled host, container
    // stopped or not; only a stopped container is restarted then.
    for (const { combo, label, hostKey } of rows) {
      assert.equal(toggleInput(container, label).checked, shownMode(combo), `${label} toggle`);
      assert.equal(hostPinNoteOf(container, label), combo.pin === 'none' ? null : hostKey, `${label} pin note`);
      const note =
        !combo.mode.builtInSet ||
        combo.mode.builtIn === containerRuns(combo) ||
        (combo.mode.builtIn && combo.run === 'stopped')
          ? null
          : combo.mode.builtIn
            ? PENDING_BUILT_IN_NOTE
            : PENDING_EXTERNAL_NOTE;
      assert.equal(builtInNoteOf(container, label), note, `${label} note`);
    }

    fireEvent.click(toggleInput(container, 'Headless Mode'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
    const dialog = await screen.findByRole('dialog');

    const body = findFetchCall('PUT', '/api/infra/config')!.body as {
      database?: { builtIn?: boolean };
      redis?: { builtIn?: boolean };
      storage?: { builtIn?: boolean };
    };
    // A pinned host decides the mode whatever the flag says, so the untouched flag beside it is left out.
    const sentFlag = (c: Combo) => (c.pin === 'none' ? shownMode(c) : undefined);
    assert.deepEqual(
      [body.database?.builtIn, body.redis?.builtIn, body.storage?.builtIn],
      [sentFlag(database), sentFlag(redis), sentFlag(storage)],
      'the flags the save sends',
    );
    // Only a database or storage the next boot connects to somewhere else starts empty after the restart.
    assert.equal(
      within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }) !== null,
      nextHost('database', database) !== statusHost('database', database),
      'the database warning',
    );
    assert.equal(
      within(dialog).queryByText(STORAGE_WARNING, { exact: false }) !== null,
      nextHost('storage', storage) !== statusHost('storage', storage),
      'the storage warning',
    );
  });
});

test('the pending-restart note survives a successful save', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  // Storage differs between running and saved: the exact "saved, awaiting restart" state the note
  // describes. It must still be readable AFTER a save — that is the operator who chose Restart Later.
  overrides = { saved: SAVED_STORAGE_DRIFT };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  await screen.findByText(PENDING_RESTART_NOTE);

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  await waitFor(() => assert.ok(findFetchCall('PUT', '/api/infra/config'), 'expected a PUT to /infra/config'));

  assert.ok(screen.queryByText(PENDING_RESTART_NOTE), 'the pending-restart note must not vanish once a save succeeds');
});

test('a change saved and left for a later restart shows the pending-restart note', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  // Running and saved agree, so no note yet: the drift comes only from this save.
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  assert.ok(!screen.queryByText(PENDING_RESTART_NOTE), 'no note before anything is saved');

  fireEvent.click(container.querySelector<HTMLInputElement>('input[name="dbType"]')!);
  // From here on the gateway reports what the save just wrote.
  overrides = { saved: { ...SAVED_CONFIG, database: { ...SAVED_CONFIG.database, type: 'sqlite' } } };
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Later' }));

  await waitFor(() => assert.ok(screen.queryByText(PENDING_RESTART_NOTE), 'expected the pending-restart note'));
});

test('a second save before the restart still warns of the database switch the first one saved', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.change(fieldInput(container, 'Host'), { target: { value: 'new-db-host' } });
  overrides = { saved: { ...SAVED_CONFIG, database: { ...SAVED_CONFIG.database, host: 'new-db-host' } } };
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  let dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Later' }));
  // The refetched saved config now names the new host; the running database is still the old one.
  await waitFor(() =>
    assert.equal(fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/infra/config').length, 2),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
});

/** The pin note rendered inside a text field's form group, or null. */
function fieldPinNote(container: HTMLElement, labelText: string): string | null {
  return fieldInput(container, labelText).closest('.form-group')?.querySelector('.env-pin-note')?.textContent ?? null;
}

test('fields the Quick Start stack pins show the env-pin note naming their variable', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  overrides = { status: { ...INFRA_STATUS, envPinned: ['SESSION_DATA_PATH', 'STORAGE_LOCAL_PATH'] } };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  await waitFor(() => {
    assert.match(fieldPinNote(container, 'Session Data Path') ?? '', /SESSION_DATA_PATH/);
    assert.match(fieldPinNote(container, 'Storage Path') ?? '', /STORAGE_LOCAL_PATH/);
  });
  assert.equal(fieldPinNote(container, 'Browser Arguments'), null, 'an unpinned field must carry no note');
  const notes = Array.from(container.querySelectorAll('.env-pin-note')).map(note => note.textContent ?? '');
  assert.ok(!notes.some(note => note.includes('PUPPETEER_ARGS') || note.includes('PUPPETEER_HEADLESS')));
});

test('without a reported pin those fields show no note, even when running and saved values differ', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  // The stock fixtures disagree on headless (running true, saved false): a pin-only note must not
  // read that as a pin or as a pending restart.
  overrides = { status: { ...INFRA_STATUS, envPinned: [] } };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  for (const label of ['Session Data Path', 'Browser Arguments', 'Storage Path']) {
    assert.equal(fieldPinNote(container, label), null, `unexpected note under ${label}`);
  }
  const headlessRow = toggleInput(container, 'Headless Mode').closest('.toggle-row');
  assert.ok(
    !headlessRow?.nextElementSibling?.classList.contains('env-pin-note'),
    'unexpected note under Headless Mode',
  );
});

// The documented .env route to external services: the hosts are pinned, so the Use Built-in toggle cannot take
// effect, and the note under it says which variable decides instead of the toggle reading OFF again after a reload.
test('a host the environment pins is named under its Use Built-in toggle', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      database: { connected: true, type: 'postgres', host: 'db.external.example', builtIn: false },
      redis: { enabled: true, connected: true, host: 'cache.external.example', port: 6379, builtIn: false },
      storage: { type: 's3', bucket: 'media', builtIn: false, s3Available: true },
      envPinned: ['DATABASE_HOST', 'REDIS_HOST', 'S3_ENDPOINT'],
    },
    saved: {
      ...SAVED_CONFIG,
      database: { ...SAVED_CONFIG.database, host: 'db.external.example', builtIn: false, builtInSet: false },
      redis: {
        enabled: true,
        builtIn: false,
        builtInSet: false,
        host: 'cache.external.example',
        port: '6379',
        passwordSet: false,
      },
      storage: { ...SAVED_CONFIG.storage, type: 's3', builtIn: false, builtInSet: false },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(hostPinNoteOf(container, 'Use Built-in PostgreSQL Container'), 'DATABASE_HOST');
  assert.equal(hostPinNoteOf(container, 'Use Built-in Redis Container'), 'REDIS_HOST');
  assert.equal(hostPinNoteOf(container, 'Use Built-in MinIO Container'), 'S3_ENDPOINT');
});

// Every other setting a save writes, as GET /infra/status reports it: external services so each field shows.
const RUNNING_EXTERNAL_ALL: InfraStatus = {
  ...INFRA_STATUS,
  database: { connected: true, type: 'postgres', host: 'db.ext.example', builtIn: false },
  redis: { enabled: true, connected: true, host: 'cache.ext.example', port: 6379, builtIn: false },
  queue: { enabled: true, webhooks: { pending: 0, completed: 0, failed: 0 } },
  storage: { type: 's3', bucket: 'media', endpoint: 'https://s3.ext.example', builtIn: false, s3Available: true },
};
const SAVED_EXTERNAL_ALL: SavedConfig = {
  ...SAVED_CONFIG,
  database: { ...SAVED_CONFIG.database, host: 'db.ext.example', sslEnabled: true },
  redis: {
    enabled: true,
    builtIn: false,
    builtInSet: true,
    host: 'cache.ext.example',
    port: '6379',
    passwordSet: true,
  },
  queue: { enabled: true },
  storage: {
    ...SAVED_CONFIG.storage,
    type: 's3',
    s3Bucket: 'media',
    s3Region: 'eu-west-1',
    s3Endpoint: 'https://s3.ext.example',
    s3CredentialsSet: true,
  },
};
const DETAIL_PINS = {
  database: [
    'POSTGRES_BUILTIN',
    'DATABASE_PORT',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
    'DATABASE_NAME',
    'DATABASE_POOL_SIZE',
    'POSTGRES_SCHEMA',
    'DATABASE_SSL',
    'DATABASE_SSL_REJECT_UNAUTHORIZED',
  ],
  redis: ['REDIS_BUILTIN', 'REDIS_TLS', 'REDIS_USERNAME', 'REDIS_PORT', 'REDIS_PASSWORD', 'QUEUE_ENABLED'],
  storage: ['MINIO_BUILTIN', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
};

function infraCard(container: HTMLElement, heading: string): HTMLElement {
  const card = Array.from(container.querySelectorAll<HTMLElement>('.infra-card')).find(
    c => c.querySelector('h2')?.textContent === heading,
  );
  if (!card) throw new Error(`no card "${heading}"`);
  return card;
}

/** The variables the pin notes right after an element name, in order. */
function pinNamesAfter(element: Element | null | undefined): string[] {
  const names: string[] = [];
  for (
    let next = element?.nextElementSibling;
    next?.classList.contains('env-pin-note');
    next = next.nextElementSibling
  ) {
    const name = ENV_PIN_NOTE.exec(next.textContent?.trim() ?? '')?.[1];
    if (name) names.push(name);
  }
  return names;
}

test('every setting a save writes names its variable beside its field when the environment pins it', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = {
    status: { ...RUNNING_EXTERNAL_ALL, envPinned: Object.values(DETAIL_PINS).flat() },
    saved: SAVED_EXTERNAL_ALL,
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  const db = infraCard(container, 'Database Configuration');
  const redis = infraCard(container, 'Redis');
  const storage = infraCard(container, 'Storage Configuration');
  const row = (card: HTMLElement, label: string) => fieldInput(card, label).closest('.form-row');
  const toggleRow = (card: HTMLElement, label: string) => toggleInput(card, label).closest('.toggle-row');
  assert.deepEqual(
    {
      dbBuiltIn: pinNamesAfter(toggleRow(db, 'Use Built-in PostgreSQL Container')),
      dbHostRow: pinNamesAfter(row(db, 'Host')),
      dbCredentialRow: pinNamesAfter(row(db, 'Username')),
      dbNameRow: pinNamesAfter(row(db, 'Database Name')),
      dbSchemaRow: pinNamesAfter(row(db, 'Schema')),
      dbSsl: pinNamesAfter(toggleRow(db, 'SSL Connection')),
      dbSslVerify: pinNamesAfter(toggleRow(db, 'Verify SSL Certificate')),
      redisBuiltIn: pinNamesAfter(toggleRow(redis, 'Use Built-in Redis Container')),
      redisRow: pinNamesAfter(row(redis, 'Host')),
      queue: pinNamesAfter(toggleRow(redis, 'Enable BullMQ Queue System')),
      storageBuiltIn: pinNamesAfter(toggleRow(storage, 'Use Built-in MinIO Container')),
      storageBucketRow: pinNamesAfter(row(storage, 'Bucket Name')),
      storageKeyRow: pinNamesAfter(row(storage, 'Access Key')),
    },
    {
      dbBuiltIn: ['POSTGRES_BUILTIN'],
      dbHostRow: ['DATABASE_PORT'],
      dbCredentialRow: ['DATABASE_USERNAME', 'DATABASE_PASSWORD'],
      dbNameRow: ['DATABASE_NAME', 'DATABASE_POOL_SIZE'],
      dbSchemaRow: ['POSTGRES_SCHEMA'],
      dbSsl: ['DATABASE_SSL'],
      dbSslVerify: ['DATABASE_SSL_REJECT_UNAUTHORIZED'],
      redisBuiltIn: ['REDIS_BUILTIN', 'REDIS_TLS', 'REDIS_USERNAME'],
      redisRow: ['REDIS_PORT', 'REDIS_PASSWORD'],
      queue: ['QUEUE_ENABLED'],
      storageBuiltIn: ['MINIO_BUILTIN'],
      storageBucketRow: ['S3_BUCKET', 'S3_REGION'],
      storageKeyRow: ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    },
  );
  const notes = Array.from(container.querySelectorAll('.env-pin-note')).map(note => note.textContent?.trim() ?? '');
  assert.equal(notes.length, Object.values(DETAIL_PINS).flat().length, 'one note per pinned variable');
});

// Use Built-in hides the detail fields while the save writes the bundled port, user, database, schema, TLS, password,
// bucket, region and keys for them; a pinned one still wins at boot, so its note moves under the toggle.
test('under Use Built-in every pinned setting the save writes is named under the toggle', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  overrides = {
    status: { ...RUNNING_EXTERNAL_ALL, envPinned: Object.values(DETAIL_PINS).flat() },
    saved: SAVED_EXTERNAL_ALL,
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  const db = infraCard(container, 'Database Configuration');
  const redis = infraCard(container, 'Redis');
  const storage = infraCard(container, 'Storage Configuration');
  const toggleRow = (card: HTMLElement, label: string) => toggleInput(card, label).closest('.toggle-row');
  for (const [card, label] of [
    [db, 'Use Built-in PostgreSQL Container'],
    [redis, 'Use Built-in Redis Container'],
    [storage, 'Use Built-in MinIO Container'],
  ] as const) {
    fireEvent.click(toggleInput(card, label));
  }

  assert.deepEqual(
    {
      database: pinNamesAfter(toggleRow(db, 'Use Built-in PostgreSQL Container')),
      redis: pinNamesAfter(toggleRow(redis, 'Use Built-in Redis Container')),
      queue: pinNamesAfter(toggleRow(redis, 'Enable BullMQ Queue System')),
      storage: pinNamesAfter(toggleRow(storage, 'Use Built-in MinIO Container')),
    },
    {
      database: DETAIL_PINS.database,
      redis: DETAIL_PINS.redis.filter(key => key !== 'QUEUE_ENABLED'),
      queue: ['QUEUE_ENABLED'],
      storage: DETAIL_PINS.storage,
    },
  );
  const notes = Array.from(container.querySelectorAll('.env-pin-note')).map(note => note.textContent?.trim() ?? '');
  assert.equal(notes.length, Object.values(DETAIL_PINS).flat().length, 'one note per pinned variable');
});

test('without a reported pin the settings a save writes show no pin note', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { status: { ...RUNNING_EXTERNAL_ALL, envPinned: [] }, saved: SAVED_EXTERNAL_ALL };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  const notes = Array.from(container.querySelectorAll('.env-pin-note')).map(note => note.textContent?.trim() ?? '');
  assert.deepEqual(notes, []);
});

// The three *_BUILTIN flags pinned true, after the page switched every service to an external server and the restart
// applied it: GET /config reads the saved external choice (the host decides), the containers run because the pinned
// flags start them at every boot. The note under each toggle says so, and an unrelated save keeps the switch.
const FLAG_PIN_NOTE = (name: string) =>
  `Pinned by the environment variable ${name}: the built-in container still starts at every boot while it is set to true and this service is in use, even with this toggle off.`;
const RUNNING_EXTERNAL_FLAGS_PINNED: InfraStatus = {
  ...RUNNING_EXTERNAL_ALL,
  database: { ...RUNNING_EXTERNAL_ALL.database, running: true },
  redis: { ...RUNNING_EXTERNAL_ALL.redis, running: true },
  storage: { ...RUNNING_EXTERNAL_ALL.storage, running: true },
  envPinned: ['POSTGRES_BUILTIN', 'REDIS_BUILTIN', 'MINIO_BUILTIN'],
};
const SAVED_EXTERNAL_SET: SavedConfig = {
  ...SAVED_EXTERNAL_ALL,
  database: { ...SAVED_EXTERNAL_ALL.database, builtIn: false, builtInSet: true },
  storage: { ...SAVED_EXTERNAL_ALL.storage, builtIn: false, builtInSet: true },
};

test('a flag the environment pins says the bundled container still starts at every boot', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_EXTERNAL_FLAGS_PINNED, saved: SAVED_EXTERNAL_SET };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  const toggles = [
    ['Use Built-in PostgreSQL Container', 'POSTGRES_BUILTIN'],
    ['Use Built-in Redis Container', 'REDIS_BUILTIN'],
    ['Use Built-in MinIO Container', 'MINIO_BUILTIN'],
  ];
  assert.deepEqual(
    toggles.map(([label]) => [toggleInput(container, label).checked, notesUnderToggle(container, label)]),
    toggles.map(([, flag]) => [false, [FLAG_PIN_NOTE(flag)]]),
  );

  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  const body = findFetchCall('PUT', '/api/infra/config')!.body as Record<string, { builtIn?: boolean; host?: string }>;
  assert.deepEqual(
    [body.database.builtIn, body.database.host, body.redis.builtIn, body.redis.host, body.storage.builtIn],
    [false, 'db.ext.example', false, 'cache.ext.example', false],
  );
  assert.doesNotMatch(dialog.textContent ?? '', /The new database starts empty|not moved to the new storage/);
});

// A host pinned elsewhere starts nothing whatever the flag says, so the flag is one more pinned value there.
test('beside a host pinned elsewhere a pinned flag gets the plain pin note', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = {
    status: { ...RUNNING_EXTERNAL_FLAGS_PINNED, envPinned: ['DATABASE_HOST', 'POSTGRES_BUILTIN'] },
    saved: { ...SAVED_EXTERNAL_SET, database: { ...SAVED_EXTERNAL_SET.database, builtInSet: false } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  const notes = notesUnderToggle(container, 'Use Built-in PostgreSQL Container');
  assert.deepEqual(
    notes.map(note => [ENV_PIN_NOTE.exec(note)?.[1], /this is the running value/.test(note)]),
    [
      ['DATABASE_HOST', true],
      ['POSTGRES_BUILTIN', true],
    ],
  );
});

// The next boot reads a pinned bucket, port or database name whatever the form holds, so an edit there moves nothing;
// a field beside it the pin does not cover still does.
for (const { pin, label, value, warns } of [
  { pin: 'S3_BUCKET', label: 'Bucket Name', value: 'newbucket', warns: false },
  { pin: 'S3_BUCKET', label: 'Custom Endpoint (optional)', value: 'https://s3.new.example', warns: true },
  { pin: 'DATABASE_NAME', label: 'Database Name', value: 'otherdb', warns: false },
  { pin: 'DATABASE_PORT', label: 'Port', value: '5433', warns: false },
  { pin: 'DATABASE_NAME', label: 'Host', value: 'db.new.example', warns: true },
  { pin: 'DATABASE_PORT', label: 'Database Name', value: 'otherdb', warns: true },
]) {
  test(`with ${pin} pinned, an edit of ${label} ${warns ? 'still warns of a data move' : 'warns of no data move'}`, async () => {
    const { screen, fireEvent, within } = rtl;
    resetFetchCalls();
    overrides = {
      status: { ...RUNNING_EXTERNAL_ALL, envPinned: [pin] },
      saved: {
        ...SAVED_EXTERNAL_ALL,
        database: { ...SAVED_EXTERNAL_ALL.database, port: '6432', database: 'appdb', sslEnabled: false },
      },
    };
    const { container } = renderInfrastructure();

    await screen.findByText('Database Configuration');
    await awaitSeeded(container);
    const card = infraCard(container, pin.startsWith('S3_') ? 'Storage Configuration' : 'Database Configuration');
    fireEvent.change(fieldInput(card, label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

    const dialog = await screen.findByRole('dialog');
    const warning = pin.startsWith('S3_') ? STORAGE_WARNING : DB_SWITCH_WARNING;
    assert.equal(within(dialog).queryByText(warning, { exact: false }) !== null, warns, 'the data-backend warning');
  });
}

test('the engine radio seeds from the effective engine when ENGINE_TYPE is pinned', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  // Under a pin, /config reports the pinned (effective) engine — the value /status also reports —
  // so the stock fixtures (both whatsapp-web.js) model the honest pinned response. The radio must
  // show what actually runs, with the pin note explaining why a save here cannot change it (#1313).
  overrides = { status: PINNED_STATUS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  await waitFor(() =>
    assert.equal(
      engineRadios(container)[0].checked,
      true,
      'expected the pinned engine (whatsapp-web.js) to be selected',
    ),
  );
  assert.ok(
    screen.getByText(/Pinned by the environment variable ENGINE_TYPE/, { exact: false }),
    'the pin note must explain why the radio cannot take effect',
  );
});

// The same for the database type, the storage type and the Redis switch: /config reports a pinned value as the
// effective one, and sending it back would write the pin over the stored choice and drop that mode's settings.
test('saving while the selections are pinned leaves them out so the stored choices survive', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  overrides = { status: { ...INFRA_STATUS, envPinned: ['DATABASE_TYPE', 'REDIS_ENABLED', 'STORAGE_TYPE'] } };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => assert.ok(findFetchCall('PUT', '/api/infra/config'), 'expected a PUT to /infra/config'));
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database: Record<string, unknown>;
    redis: Record<string, unknown>;
    storage: Record<string, unknown>;
  };
  assert.deepEqual(['type' in body.database, 'enabled' in body.redis, 'type' in body.storage], [false, false, false]);
  assert.equal(body.database.username, 'openwa_admin', 'the rest of the section still goes out');
});

// The compose .env route: the type is pinned and the file holds the first-boot SQLite. A PostgreSQL field edited on
// the page belongs to the pinned mode, so the save names it rather than letting the stored SQLite drop the edit.
test('a field edited in a pinned database card is saved with its type', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  overrides = { status: { ...INFRA_STATUS, envPinned: ['DATABASE_TYPE', 'STORAGE_TYPE'] } };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.click(toggleInput(container, 'SSL Connection'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => assert.ok(findFetchCall('PUT', '/api/infra/config'), 'expected a PUT to /infra/config'));
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database: { type?: string; sslEnabled?: boolean };
    storage: Record<string, unknown>;
  };
  assert.deepEqual([body.database.type, body.database.sslEnabled], ['postgres', true]);
  assert.equal('type' in body.storage, false, 'the untouched storage card');
});

test('a pinned selection the operator changes is saved', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  overrides = { status: { ...INFRA_STATUS, envPinned: ['DATABASE_TYPE', 'REDIS_ENABLED', 'STORAGE_TYPE'] } };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="dbType"]')[0]);
  fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="storageType"]')[1]);
  fireEvent.click(toggleInput(container, 'Enable Redis'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => assert.ok(findFetchCall('PUT', '/api/infra/config'), 'expected a PUT to /infra/config'));
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database: { type?: string };
    redis: { enabled?: boolean };
    storage: { type?: string };
  };
  assert.deepEqual([body.database.type, body.redis.enabled, body.storage.type], ['sqlite', true, 's3']);
});

test('saving while ENGINE_TYPE is pinned omits engine.type so the stored choice survives', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  // The stored ENGINE_TYPE in data/.env.generated is invisible to the dashboard while the pin
  // holds (/config reports the effective engine). The operator never touched the radio here, so
  // the payload must OMIT type: sending the pinned seed would bake the pin over the stored choice,
  // and unsetting the variable later could not restore it (#1082).
  overrides = { status: PINNED_STATUS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { engine?: { type?: string } };
    assert.equal(body.engine?.type, undefined, 'an untouched pinned seed must not be persisted');
  });
});

test('an operator engine pick under a pin is deliberate and still saved', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  // The pin note says dashboard changes won't APPLY until the variable is unset — it does not say
  // the choice cannot be stored. Clicking a radio is an explicit selection (engineTouched), so it
  // must reach the payload and replace the stored intent for the post-unpin boot.
  overrides = { status: PINNED_STATUS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  fireEvent.click(engineRadios(container)[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { engine?: { type?: string } };
    assert.equal(body.engine?.type, 'baileys');
  });
});

// The dashboard key is a password a browser may have saved for this origin. These fields hold other secrets
// (an empty one means "keep the stored value"), so the browser must not fill them with it.
test('the database, Redis and S3 secret fields are not offered saved passwords', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      redis: { enabled: true, connected: true, host: 'redis.example', port: 6379, builtIn: false },
      storage: { type: 's3', bucket: 'media', builtIn: false },
    },
    saved: {
      ...SAVED_CONFIG,
      redis: {
        enabled: true,
        builtIn: false,
        builtInSet: true,
        host: 'redis.example',
        port: '6379',
        passwordSet: true,
      },
      storage: { ...SAVED_CONFIG.storage, type: 's3' },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  await waitFor(() => assert.equal(container.querySelectorAll('input[type="password"]').length, 3));
  for (const field of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
    assert.equal(field.getAttribute('autocomplete'), 'new-password', field.id);
  }
});

// ── Built-in containers the restart stops ────────────────────────────────────

test('turning a running built-in Redis off asks the restart to stop its container', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  // Built-in Redis is running and saved as built-in; the operator switches it to an external Redis.
  overrides = {
    // Docker answered: the server reports running on all three.
    status: {
      ...INFRA_STATUS,
      database: { ...INFRA_STATUS.database, running: false },
      redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true, running: true },
      storage: { ...INFRA_STATUS.storage, running: false },
    },
    saved: {
      ...SAVED_CONFIG,
      redis: { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false },
    },
    savedAfterSave: {
      ...SAVED_CONFIG,
      redis: {
        enabled: true,
        builtIn: false,
        builtInSet: true,
        host: 'cache.example.com',
        port: '6379',
        passwordSet: false,
      },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const builtInRedis = toggleInput(container, 'Use Built-in Redis Container');
  await waitFor(() => assert.equal(builtInRedis.checked, true));
  fireEvent.click(builtInRedis);
  fireEvent.change(fieldInput(card(container, 'Redis'), 'Host'), { target: { value: 'cache.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.deepEqual(stopNames(dialog), ['openwa-redis']);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  // The page reloads after every restart, so the first save of a page visit is the normal case: the
  // container to stop must come from what is running, not from an earlier save on this page.
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, { profiles: [], profilesToRemove: ['redis'] });
});

// With Docker unreachable the status carries no running key and builtIn is the saved flag: the server only writes a
// signal file then, so the dialog names nothing, and the request is the one the page sent before.
test('with Docker unreachable the restart dialog names no container to stop', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  const redis = { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false };
  overrides = {
    status: { ...INFRA_STATUS, redis: { enabled: true, connected: false, host: 'redis', port: 6379, builtIn: true } },
    saved: { ...SAVED_CONFIG, redis },
    savedAfterSave: { ...SAVED_CONFIG, redis: { ...redis, builtIn: false, host: 'cache.example.com' } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const builtInRedis = toggleInput(container, 'Use Built-in Redis Container');
  await waitFor(() => assert.equal(builtInRedis.checked, true));
  fireEvent.click(builtInRedis);
  fireEvent.change(fieldInput(card(container, 'Redis'), 'Host'), { target: { value: 'cache.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.doesNotMatch(dialog.textContent ?? '', /openwa-/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, { profiles: [], profilesToRemove: ['redis'] });
});

function card(container: HTMLElement, heading: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>('.infra-card')).find(
    c => c.querySelector('h2')?.textContent === heading,
  );
  if (!found) throw new Error(`no card headed "${heading}"`);
  return found;
}

// The restart never stops a container the next boot still reaches, read from the file the save wrote, so the page
// asks for and names only the others.
test('a built-in Redis switched off but left on the bundled host is neither stopped nor named', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  const redis = { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false };
  overrides = {
    status: { ...INFRA_STATUS, redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true } },
    saved: { ...SAVED_CONFIG, redis },
    savedAfterSave: { ...SAVED_CONFIG, redis: { ...redis, builtIn: false } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const builtInRedis = toggleInput(container, 'Use Built-in Redis Container');
  await waitFor(() => assert.equal(builtInRedis.checked, true));
  fireEvent.click(builtInRedis);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.doesNotMatch(dialog.textContent ?? '', /openwa-/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, { profiles: [], profilesToRemove: [] });
});

// The server reads the saved host from the file the save wrote. Without the read-back the page cannot know it, so it
// neither asks to stop that container nor names it: the dialog lists only what the server stops.
test('a built-in Redis left on the bundled host is neither stopped nor named when the read-back fails', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  const redis = { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false };
  overrides = {
    status: {
      ...INFRA_STATUS,
      redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true, running: true },
    },
    saved: { ...SAVED_CONFIG, redis },
    savedAfterSaveFails: true,
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const builtInRedis = toggleInput(container, 'Use Built-in Redis Container');
  await waitFor(() => assert.equal(builtInRedis.checked, true));
  fireEvent.click(builtInRedis);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.doesNotMatch(dialog.textContent ?? '', /openwa-/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, { profiles: [], profilesToRemove: [] });
});

// A pinned host is known without the read-back: one that reaches the container keeps it.
test('bundled containers the pinned hosts reach are neither stopped nor named when the read-back fails', async () => {
  resetFetchCalls();
  overrides = {
    status: { ...RUNNING_BUNDLED, envPinned: ['DATABASE_HOST', 'REDIS_HOST', 'S3_ENDPOINT'] },
    saved: {
      ...SAVED_CONFIG,
      database: { ...SAVED_CONFIG.database, builtIn: true, builtInSet: false, host: 'postgres' },
      redis: { enabled: true, builtIn: true, builtInSet: false, host: 'redis', port: '6379', passwordSet: false },
      storage: {
        ...SAVED_CONFIG.storage,
        type: 's3',
        builtIn: true,
        builtInSet: false,
        s3Bucket: 'openwa',
        s3Endpoint: 'http://minio:9000',
      },
    },
    savedAfterSaveFails: true,
  };

  const { dialogText, names, body } = await saveAndRestart();

  assert.deepEqual(names, []);
  assert.doesNotMatch(dialogText, /openwa-/);
  assert.deepEqual(body, { profiles: [], profilesToRemove: [] });
});

// The save writes the host a built-in service is switched to as sent (trimmed, or dropped with another type), so
// without the read-back the page takes it from the payload: a host that reaches the bundled container keeps it, any
// other stops it, and the dialog names it.
const READBACK_SAVED: SavedConfig = {
  ...SAVED_CONFIG,
  database: { ...SAVED_CONFIG.database, builtIn: true, host: 'postgres' },
  redis: { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false },
  storage: {
    ...SAVED_CONFIG.storage,
    type: 's3',
    builtIn: true,
    s3Bucket: 'openwa',
    s3Endpoint: 'http://minio:9000',
  },
};
const BUILT_IN_SWITCHES = [
  ['database', 'postgres', 'Use Built-in PostgreSQL Container', 'Database Configuration', 'Host'],
  ['redis', 'redis', 'Use Built-in Redis Container', 'Redis', 'Host'],
  ['storage', 'minio', 'Use Built-in MinIO Container', 'Storage Configuration', 'Custom Endpoint (optional)'],
] as const;
const CONTAINER_NAMES: Record<string, string> = {
  postgres: 'openwa-postgres',
  redis: 'openwa-redis',
  minio: 'openwa-minio',
};

// `kept` is what the save answers with: the profiles of the built-in services left on.
async function switchWithoutReadBack(
  kept: string[],
  edit: (container: HTMLElement) => void,
): Promise<{ names: string[]; body: unknown }> {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_BUNDLED, saved: READBACK_SAVED, savedAfterSaveFails: true, saveProfiles: kept };
  const { container } = renderInfrastructure();
  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  edit(container);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  const names = stopNames(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  return { names, body: findFetchCall('POST', '/api/infra/restart')!.body };
}

for (const [service, profile, toggle, heading, field] of BUILT_IN_SWITCHES) {
  const hosts = [
    ...HOST_SPELLINGS[service].reach.map(host => [host, true] as const),
    ...HOST_SPELLINGS[service].elsewhere.map(host => [host, false] as const),
  ];
  for (const [host, reach] of hosts) {
    test(`a built-in ${service} switched to ${JSON.stringify(host)} is ${reach ? 'kept' : 'stopped'} when the read-back fails`, async () => {
      const { fireEvent } = rtl;
      const kept = ['postgres', 'redis', 'minio'].filter(p => p !== profile);
      const { names, body } = await switchWithoutReadBack(kept, container => {
        fireEvent.click(toggleInput(container, toggle));
        fireEvent.change(fieldInput(card(container, heading), field), { target: { value: host } });
      });

      assert.deepEqual(names, reach ? [] : [CONTAINER_NAMES[profile]]);
      assert.deepEqual(body, { profiles: kept, profilesToRemove: reach ? [] : [profile] });
    });
  }
}

test('a built-in database and storage switched to SQLite and local are stopped when the read-back fails', async () => {
  const { fireEvent } = rtl;
  const { names, body } = await switchWithoutReadBack(['redis'], container => {
    fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="dbType"]')[0]);
    fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="storageType"]')[0]);
  });

  assert.deepEqual(names, ['openwa-postgres', 'openwa-minio']);
  assert.deepEqual(body, { profiles: ['redis'], profilesToRemove: ['postgres', 'minio'] });
});

// A built-in Redis nothing uses any more is saved without its profile, and the save drops its host.
test('a built-in Redis switched off is stopped when the read-back fails', async () => {
  const { fireEvent } = rtl;
  const { names, body } = await switchWithoutReadBack(['postgres', 'minio'], container => {
    fireEvent.click(toggleInput(container, 'Enable Redis'));
  });

  assert.deepEqual(names, ['openwa-redis']);
  assert.deepEqual(body, { profiles: ['postgres', 'minio'], profilesToRemove: ['redis'] });
});

// The cache may still use Redis, and the page cannot see it: a host on the bundled name, switched off from a built-in
// Redis together with Redis itself, is the server's to drop or keep, so its container is not asked to stop.
test('a Redis switched off beside a host on the bundled name is not stopped when the read-back fails', async () => {
  const { fireEvent } = rtl;
  const { names, body } = await switchWithoutReadBack(['postgres', 'minio'], container => {
    fireEvent.click(toggleInput(container, 'Use Built-in Redis Container'));
    fireEvent.click(toggleInput(container, 'Enable Redis'));
  });

  assert.deepEqual(names, []);
  assert.deepEqual(body, { profiles: ['postgres', 'minio'], profilesToRemove: [] });
});

// With REDIS_ENABLED pinned, an untouched switch is left out of the save, and the stored value the file keeps decides.
test('a built-in Redis whose switch the environment pins is not stopped when the read-back fails', async () => {
  resetFetchCalls();
  overrides = {
    status: { ...RUNNING_BUNDLED, envPinned: ['REDIS_ENABLED'] },
    saved: { ...READBACK_SAVED, redis: { ...READBACK_SAVED.redis, enabled: false } },
    savedAfterSaveFails: true,
    saveProfiles: ['postgres', 'minio'],
  };

  const { names, body } = await saveAndRestart();

  assert.deepEqual(names, []);
  assert.deepEqual(body, { profiles: ['postgres', 'minio'], profilesToRemove: [] });
});

for (const key of ['REDIS_ENABLED', 'QUEUE_ENABLED'] as const) {
  for (const enabled of [false, true]) {
    test(`a pinned ${key} uses its running value ${enabled} when the saved read fails`, async () => {
      resetFetchCalls();
      overrides = {
        status: {
          ...RUNNING_BUNDLED,
          envPinned: [key],
          redis: { ...RUNNING_BUNDLED.redis, enabled: key === 'REDIS_ENABLED' ? enabled : false },
          queue: { ...RUNNING_BUNDLED.queue, enabled: key === 'QUEUE_ENABLED' ? enabled : false },
        },
        saved: {
          ...READBACK_SAVED,
          redis: { ...READBACK_SAVED.redis, enabled: key === 'REDIS_ENABLED' ? !enabled : false },
          queue: { enabled: key === 'QUEUE_ENABLED' ? !enabled : false },
        },
        savedAfterSaveFails: true,
        saveProfiles: ['postgres', 'minio'],
      };
      const { names, body } = await saveAndRestart();
      assert.deepEqual(names, enabled ? [] : ['openwa-redis']);
      assert.deepEqual(body, { profiles: ['postgres', 'minio'], profilesToRemove: enabled ? [] : ['redis'] });
    });
  }
}

test('bundled containers the environment pins the hosts to are neither stopped nor named', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: { ...RUNNING_BUNDLED, envPinned: ['DATABASE_HOST', 'REDIS_HOST', 'S3_ENDPOINT'] },
    saved: {
      ...SAVED_CONFIG,
      database: { ...SAVED_CONFIG.database, builtIn: true, builtInSet: false, host: 'postgres' },
      redis: { enabled: true, builtIn: true, builtInSet: false, host: 'redis', port: '6379', passwordSet: false },
      storage: {
        ...SAVED_CONFIG.storage,
        type: 's3',
        builtIn: true,
        builtInSet: false,
        s3Endpoint: 'http://minio:9000',
      },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.doesNotMatch(dialog.textContent ?? '', /openwa-/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, { profiles: [], profilesToRemove: [] });
});

// Containers the dashboard created, then the environment pinned the three hosts to external services: the next boot
// uses none of them, and the save still asks for the profiles of the stored built-in flags.
const PINNED_AWAY: InfraStatus = {
  ...INFRA_STATUS,
  database: { connected: true, type: 'postgres', host: 'db.ext.example', builtIn: false, running: true },
  redis: { enabled: true, connected: true, host: 'cache.ext.example', port: 6379, builtIn: false, running: true },
  storage: {
    type: 's3',
    bucket: 'media',
    endpoint: 'https://s3.ext.example',
    builtIn: false,
    running: true,
    s3Available: true,
  },
  envPinned: ['DATABASE_TYPE', 'DATABASE_HOST', 'REDIS_ENABLED', 'REDIS_HOST', 'STORAGE_TYPE', 'S3_ENDPOINT'],
};
const PINNED_AWAY_SAVED: SavedConfig = {
  ...SAVED_CONFIG,
  database: { ...SAVED_CONFIG.database, builtIn: false, builtInSet: false, host: 'db.ext.example' },
  redis: {
    enabled: true,
    builtIn: false,
    builtInSet: false,
    host: 'cache.ext.example',
    port: '6379',
    passwordSet: false,
  },
  storage: {
    ...SAVED_CONFIG.storage,
    type: 's3',
    builtIn: false,
    builtInSet: false,
    s3Bucket: 'media',
    s3Endpoint: 'https://s3.ext.example',
  },
};

async function saveAndRestart(): Promise<{ dialogText: string; names: string[]; body: unknown }> {
  const { screen, waitFor, fireEvent, within } = rtl;
  const { container } = renderInfrastructure();
  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  const dialogText = dialog.textContent ?? '';
  const names = stopNames(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  return { dialogText, names, body: findFetchCall('POST', '/api/infra/restart')!.body };
}

test('a bundled container OpenWA created whose host the environment pins elsewhere is stopped and named', async () => {
  resetFetchCalls();
  overrides = { status: PINNED_AWAY, saved: PINNED_AWAY_SAVED, saveProfiles: ['postgres', 'redis', 'minio'] };

  const { dialogText, names, body } = await saveAndRestart();

  assert.ok(dialogText.includes(STOPS_SENTENCE), dialogText);
  assert.deepEqual(names, ALL_THREE);
  assert.deepEqual(body, { profiles: [], profilesToRemove: ['postgres', 'redis', 'minio'] });
});

// Without the read the server's own check decides: the page asks for what it would have asked for before.
test('a configuration that cannot be read back after the save still opens the restart and asks to stop', async () => {
  resetFetchCalls();
  overrides = {
    status: PINNED_AWAY,
    saved: PINNED_AWAY_SAVED,
    saveProfiles: ['postgres', 'redis', 'minio'],
    savedAfterSaveFails: true,
  };

  const { dialogText, names, body } = await saveAndRestart();

  assert.ok(dialogText.includes(STOPS_SENTENCE), dialogText);
  assert.deepEqual(names, ALL_THREE);
  assert.deepEqual(body, { profiles: [], profilesToRemove: ['postgres', 'redis', 'minio'] });
});

test('a bundled container Docker Compose created is left alone under a host pinned elsewhere', async () => {
  resetFetchCalls();
  const compose = {
    ...PINNED_AWAY,
    database: { ...PINNED_AWAY.database, running: false },
    redis: { ...PINNED_AWAY.redis, running: false },
    storage: { ...PINNED_AWAY.storage, running: false },
  };
  overrides = { status: compose, saved: PINNED_AWAY_SAVED, saveProfiles: ['postgres', 'redis', 'minio'] };

  const { dialogText, names, body } = await saveAndRestart();

  assert.deepEqual(names, []);
  assert.doesNotMatch(dialogText, /openwa-/);
  assert.deepEqual(body, { profiles: ['postgres', 'redis', 'minio'], profilesToRemove: [] });
});

test('a host pinned to the container name still reaches the container, which is kept', async () => {
  resetFetchCalls();
  const status = { ...PINNED_AWAY, database: { ...PINNED_AWAY.database, host: 'OpenWA-Postgres' } };
  const saved = { ...PINNED_AWAY_SAVED, database: { ...PINNED_AWAY_SAVED.database, host: 'OpenWA-Postgres' } };
  overrides = { status, saved, saveProfiles: ['postgres', 'redis', 'minio'] };

  const { names, body } = await saveAndRestart();

  assert.deepEqual(names, ['openwa-redis', 'openwa-minio']);
  assert.deepEqual(body, { profiles: ['postgres'], profilesToRemove: ['redis', 'minio'] });
});

// Every spelling of the bundled host the server reads as the bundled container (the shared table), taken i-th for
// each service at once: its alias, another letter case, a trailing dot, the container name.
const spellingRounds = Math.max(...Object.values(HOST_SPELLINGS).map(s => s.reach.length));
const spelling = (service: ServiceName, round: number) =>
  HOST_SPELLINGS[service].reach[round % HOST_SPELLINGS[service].reach.length];

for (let round = 0; round < spellingRounds; round++) {
  const db = spelling('database', round);
  const redisHost = spelling('redis', round);
  const s3 = spelling('storage', round);

  // A pin that still reaches the container: the server keeps it, so the page neither asks for nor names its stop.
  test(`hosts pinned to ${JSON.stringify([db, redisHost, s3])} keep the containers OpenWA created`, async () => {
    resetFetchCalls();
    const status: InfraStatus = {
      ...PINNED_AWAY,
      database: { ...PINNED_AWAY.database, host: db, builtIn: true },
      redis: { ...PINNED_AWAY.redis, host: redisHost, builtIn: true },
      storage: { ...PINNED_AWAY.storage, endpoint: s3, bucket: 'openwa', builtIn: true },
    };
    const saved: SavedConfig = {
      ...PINNED_AWAY_SAVED,
      database: { ...PINNED_AWAY_SAVED.database, host: db, builtIn: true },
      redis: { ...PINNED_AWAY_SAVED.redis, host: redisHost, builtIn: true },
      storage: { ...PINNED_AWAY_SAVED.storage, s3Endpoint: s3, s3Bucket: 'openwa', builtIn: true },
    };
    overrides = { status, saved, saveProfiles: ['postgres', 'redis', 'minio'] };

    const { dialogText, names, body } = await saveAndRestart();

    assert.deepEqual(names, []);
    assert.doesNotMatch(dialogText, /openwa-/);
    assert.deepEqual(body, { profiles: ['postgres', 'redis', 'minio'], profilesToRemove: [] });
  });

  // A saved built-in choice beside a stopped container the server already dials switches nothing.
  test(`no pending note beside a stopped container the server dials as ${JSON.stringify([db, redisHost, s3])}`, async () => {
    const { screen } = rtl;
    resetFetchCalls();
    overrides = {
      status: {
        ...RUNNING_BUNDLED,
        database: { ...RUNNING_BUNDLED.database, host: db, builtIn: false, running: false },
        redis: { ...RUNNING_BUNDLED.redis, host: redisHost, builtIn: false, running: false },
        storage: { ...RUNNING_BUNDLED.storage, endpoint: s3, builtIn: false, running: false },
      },
      saved: {
        ...SAVED_BUNDLED,
        database: { ...SAVED_BUNDLED.database, host: db },
        redis: { enabled: true, builtIn: true, builtInSet: true, host: redisHost, port: '6379', passwordSet: false },
        storage: { ...SAVED_BUNDLED.storage, s3Endpoint: s3 },
      },
    };
    const { container } = renderInfrastructure();

    await screen.findByText('Database Configuration');
    await awaitSeeded(container);
    assert.equal(
      screen.queryByText(PENDING_BUILT_IN_NOTE) === null,
      true,
      'a pending switch the restart would not make',
    );
  });

  // The bundled container under another spelling is the database and storage the server runs on now: no switch.
  test(`no data-backend warning for a built-in save over ${JSON.stringify([db, s3])}`, async () => {
    const { screen, fireEvent } = rtl;
    resetFetchCalls();
    overrides = {
      status: {
        ...RUNNING_BUNDLED,
        database: { ...RUNNING_BUNDLED.database, host: db },
        storage: { ...RUNNING_BUNDLED.storage, endpoint: s3 },
      },
      saved: {
        ...SAVED_BUNDLED,
        database: { ...SAVED_BUNDLED.database, host: db, builtInSet: true },
        storage: { ...SAVED_BUNDLED.storage, s3Endpoint: s3, s3Bucket: 'openwa', builtInSet: true },
      },
    };
    const { container } = renderInfrastructure();

    await screen.findByText('Database Configuration');
    await awaitSeeded(container);
    fireEvent.click(toggleInput(container, 'Headless Mode'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

    const dialog = await screen.findByRole('dialog');
    assert.doesNotMatch(dialog.textContent ?? '', /The new database starts empty|not moved to the new storage/);
  });

  // A database and bucket of their own on the bundled containers, saved without the flag, read as built-in: the save
  // keeps the user, database, schema and bucket they use, so nothing moves and no switch is warned of.
  test(`no data-backend warning for a save over a database and bucket of their own on ${JSON.stringify([db, s3])}`, async () => {
    const { screen, fireEvent } = rtl;
    resetFetchCalls();
    overrides = {
      status: {
        ...RUNNING_BUNDLED,
        database: { ...RUNNING_BUNDLED.database, host: db, running: false },
        redis: INFRA_STATUS.redis,
        storage: { ...RUNNING_BUNDLED.storage, endpoint: s3, bucket: 'media', running: false },
      },
      saved: {
        ...SAVED_CONFIG,
        database: {
          ...SAVED_CONFIG.database,
          builtIn: true,
          builtInSet: false,
          host: db,
          port: '5432',
          username: 'app',
          database: 'appdb',
          schema: 'tenant',
        },
        storage: {
          ...SAVED_CONFIG.storage,
          type: 's3',
          builtIn: true,
          builtInSet: false,
          s3Bucket: 'media',
          s3Region: 'eu-west-1',
          s3Endpoint: s3,
        },
      },
    };
    const { container } = renderInfrastructure();

    await screen.findByText('Database Configuration');
    await awaitSeeded(container);
    fireEvent.click(toggleInput(container, 'Headless Mode'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

    const dialog = await screen.findByRole('dialog');
    assert.doesNotMatch(dialog.textContent ?? '', /The new database starts empty|not moved to the new storage/);
    const body = findFetchCall('PUT', '/api/infra/config')!.body as {
      database?: { builtIn?: boolean };
      storage?: { builtIn?: boolean };
    };
    assert.deepEqual([body.database?.builtIn, body.storage?.builtIn], [true, true]);
  });
}

// The same values on another server are a switch to the bundled containers, which start with their own.
test('turning Use Built-in on over a database and bucket of another server warns of both switches', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      database: { connected: true, type: 'postgres', host: 'db.example.com', builtIn: false, running: false },
      storage: { type: 's3', bucket: 'media', endpoint: 'https://s3.example.com', builtIn: false, s3Available: true },
    },
    saved: {
      ...SAVED_CONFIG,
      database: { ...SAVED_CONFIG.database, host: 'db.example.com', port: '5432', database: 'appdb' },
      storage: {
        ...SAVED_CONFIG.storage,
        type: 's3',
        s3Bucket: 'media',
        s3Region: 'eu-west-1',
        s3Endpoint: 'https://s3.example.com',
      },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Use Built-in PostgreSQL Container'));
  fireEvent.click(toggleInput(container, 'Use Built-in MinIO Container'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
  within(dialog).getByText(STORAGE_WARNING, { exact: false });
});

// A bucket typed while the toggle was off stays in the form once it is on again, but the save keeps the stored one.
test('a bucket typed and then hidden by Use Built-in on the bundled MinIO is no storage switch', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      storage: { type: 's3', bucket: 'media', endpoint: 'http://openwa-minio:9000', builtIn: true, s3Available: true },
    },
    saved: {
      ...SAVED_CONFIG,
      storage: {
        ...SAVED_CONFIG.storage,
        type: 's3',
        builtIn: true,
        builtInSet: false,
        s3Bucket: 'media',
        s3Endpoint: 'http://openwa-minio:9000',
      },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(toggleInput(container, 'Use Built-in MinIO Container'));
  fireEvent.change(fieldInput(container, 'Bucket Name'), { target: { value: 'other' } });
  fireEvent.click(toggleInput(container, 'Use Built-in MinIO Container'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  assert.doesNotMatch(dialog.textContent ?? '', /not moved to the new storage/);
});

// The database card beside DATABASE_HOST pinned to an external server, over a stored built-in database: the card shows
// that server, and the typed user and database name are its own. The save sends the flag the card shows with them, so
// the gateway writes them instead of the stored bundled values, and the new database name is the switch warned of.
test('typed external fields beside a host pinned elsewhere are sent with the flag the card shows', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      database: { connected: true, type: 'postgres', host: 'db.ext.example', builtIn: false, running: true },
      envPinned: ['DATABASE_HOST'],
    },
    saved: {
      ...SAVED_CONFIG,
      database: { ...SAVED_CONFIG.database, builtIn: false, builtInSet: false, host: 'db.ext.example' },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  assert.equal(toggleInput(container, 'Use Built-in PostgreSQL Container').checked, false);
  fireEvent.change(fieldInput(container, 'Username'), { target: { value: 'app' } });
  fireEvent.change(fieldInput(container, 'Database Name'), { target: { value: 'appdb' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database?: { builtIn?: boolean; username?: string; database?: string };
  };
  assert.deepEqual([body.database?.builtIn, body.database?.username, body.database?.database], [false, 'app', 'appdb']);
  rtl.within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
});

// A database and bucket of their own on the bundled containers (flags false, hosts on the container names), switched
// away and saved with Restart Later, then switched back to Use Built-in in the same visit. The gateway keeps what the
// bundled containers serve the running process, so the second save moves nothing, unless the first one renamed the
// database on the bundled host itself, which the next boot then dials.
const RUNNING_OWN_BUNDLED: InfraStatus = {
  ...INFRA_STATUS,
  database: { connected: true, type: 'postgres', host: 'openwa-postgres', builtIn: true, running: false },
  storage: { type: 's3', bucket: 'media', endpoint: 'http://openwa-minio:9000', builtIn: true, s3Available: true },
};
const SAVED_OWN_BUNDLED: SavedConfig = {
  ...SAVED_CONFIG,
  database: {
    ...SAVED_CONFIG.database,
    host: 'openwa-postgres',
    port: '5432',
    username: 'app',
    database: 'appdb',
    schema: 'tenant',
    builtIn: true,
    builtInSet: false,
  },
  storage: {
    ...SAVED_CONFIG.storage,
    type: 's3',
    builtIn: true,
    builtInSet: false,
    s3Bucket: 'media',
    s3Region: 'eu-west-1',
    s3Endpoint: 'http://openwa-minio:9000',
  },
};
for (const { label, toggle, field, value, after, warning, warnsBack } of [
  {
    label: 'the database switched to another server',
    toggle: 'Use Built-in PostgreSQL Container',
    field: 'Host',
    value: 'db.ext.example',
    after: { database: { ...SAVED_OWN_BUNDLED.database, host: 'db.ext.example', builtIn: false, builtInSet: true } },
    warning: DB_SWITCH_WARNING,
    warnsBack: false,
  },
  {
    label: 'the database renamed on the bundled host',
    toggle: 'Use Built-in PostgreSQL Container',
    field: 'Database Name',
    value: 'appdb2',
    after: { database: { ...SAVED_OWN_BUNDLED.database, database: 'appdb2' } },
    warning: DB_SWITCH_WARNING,
    warnsBack: true,
  },
  {
    label: 'the storage switched to another endpoint',
    toggle: 'Use Built-in MinIO Container',
    field: 'Custom Endpoint (optional)',
    value: 'https://s3.new.example',
    after: {
      storage: { ...SAVED_OWN_BUNDLED.storage, s3Endpoint: 'https://s3.new.example', builtIn: false, builtInSet: true },
    },
    warning: STORAGE_WARNING,
    warnsBack: false,
  },
]) {
  test(`back to Use Built-in after ${label} and Restart Later ${warnsBack ? 'warns' : 'warns of no move'}`, async () => {
    const { screen, fireEvent, within } = rtl;
    resetFetchCalls();
    overrides = {
      status: RUNNING_OWN_BUNDLED,
      saved: SAVED_OWN_BUNDLED,
      savedAfterSave: { ...SAVED_OWN_BUNDLED, ...after },
    };
    const { container } = renderInfrastructure();

    await screen.findByText('Database Configuration');
    await awaitSeeded(container);
    fireEvent.click(toggleInput(container, toggle));
    fireEvent.change(fieldInput(container, field), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
    const first = await screen.findByRole('dialog');
    within(first).getByText(warning, { exact: false });
    fireEvent.click(within(first).getByRole('button', { name: 'Restart Later' }));
    await rtl.waitFor(() => assert.equal(screen.queryByRole('dialog'), null));

    fireEvent.click(toggleInput(container, toggle));
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
    const second = await screen.findByRole('dialog');
    assert.equal(within(second).queryByText(warning, { exact: false }) !== null, warnsBack);
  });
}

// ── Restart-flow timer cleanup on unmount ────────────────────────────────────

test('unmounting mid-restart cancels the health poll and countdown timers', { timeout: 10_000 }, async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  const { unmount } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

  // The restart POST resolving is what arms the 3s health-poll timeout chain and the 1s countdown
  // interval in useRestartFlow.
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));

  // Unmount, then outwait the first health poll (fires at 3s): a leaked chain would call
  // /api/health/ready here. Real timers only — mixing fake timers in after the flow has armed
  // would leave the pre-armed real handles un-clearable by the mocked clearTimeout.
  unmount();
  resetFetchCalls();
  await new Promise(resolve => setTimeout(resolve, 4000));

  assert.equal(findFetchCall('GET', '/api/health/ready'), undefined);
});

// ── Restart outcomes the server reports ──────────────────────────────────────

test('a refused restart shows the server reason and never polls readiness', { timeout: 10_000 }, async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  // The old process refused before scheduling a shutdown, so it is still up: a readiness poll would
  // answer 200 and report a restart that never happened.
  overrides = { restart: () => jsonResponse({ message: 'Too many restart requests' }, 429) };
  renderInfrastructure();

  await screen.findByText('Database Configuration');
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

  await within(dialog).findByText('Restart failed');
  assert.ok(within(dialog).getByText('Too many restart requests'), 'the server reason is not shown');
  // Past the first readiness poll (3s), which a restart assumed to be under way would have sent.
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(findFetchCall('GET', '/api/health/ready'), undefined);
  assert.equal(within(dialog).queryByText('Server ready') === null, true);
});

test(
  'a proxy timeout on the restart request reports an unknown outcome, not a failure',
  { timeout: 12_000 },
  async () => {
    const { screen, fireEvent, within } = rtl;
    resetFetchCalls();
    // The proxy stopped waiting while the gateway was still pulling an image: the restart may yet happen,
    // and the old process still answers readiness, so neither a failure nor a poll tells the truth.
    overrides = {
      restart: () =>
        new Response('<html><body>504 Gateway Time-out</body></html>', {
          status: 504,
          headers: { 'Content-Type': 'text/html' },
        }),
    };
    // jsdom cannot navigate, so a reload reports itself through console.error; count those.
    const navigations: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
      if (text.includes('navigation')) navigations.push(text);
      else consoleError(...args);
    };
    try {
      renderInfrastructure();
      await screen.findByText('Database Configuration');
      fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

      await within(dialog).findByText(
        'The proxy returned an error before the server answered, so it is not known whether the restart is in progress. Reload in a minute to check.',
      );
      assert.equal(within(dialog).queryByText('Restart failed') === null, true);
      assert.equal(within(dialog).queryByText('HTTP 504') === null, true);
      assert.ok(within(dialog).getByText('Please wait…'), 'the unknown outcome has no neutral title');
      assert.ok(within(dialog).getByRole('button', { name: 'Reload Page' }), 'no way to reload by hand');
      // Past the first readiness poll (3s) and the reload a confirmed restart schedules 2s after it.
      await new Promise(resolve => setTimeout(resolve, 5500));
      assert.equal(findFetchCall('GET', '/api/health/ready'), undefined);
      assert.deepEqual(navigations, [], 'the page reloaded on its own');
    } finally {
      console.error = consoleError;
    }
  },
);

async function clickRestartNow() {
  const { screen, fireEvent, within } = rtl;
  renderInfrastructure();
  await screen.findByText('Database Configuration');
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  return dialog;
}

test('a proxy 502 without a gateway code on the restart request reports an unknown outcome', async () => {
  const { within } = rtl;
  resetFetchCalls();
  overrides = {
    restart: () =>
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
  };
  const dialog = await clickRestartNow();

  await within(dialog).findByText(
    'The proxy returned an error before the server answered, so it is not known whether the restart is in progress. Reload in a minute to check.',
  );
  assert.equal(within(dialog).queryByText('Restart failed') === null, true);
});

test('a 502 the gateway stamped with a code is a refusal, not an unknown outcome', async () => {
  const { within } = rtl;
  resetFetchCalls();
  overrides = { restart: () => jsonResponse({ message: 'Compose rejected the profile', code: 'SOME_CODE' }, 502) };
  const dialog = await clickRestartNow();

  await within(dialog).findByText('Restart failed');
  assert.ok(within(dialog).getByText('Compose rejected the profile'), 'the server reason is not shown');
});

test('the restart progress bar measures the server estimate, not a fixed 30 s', async () => {
  const { within } = rtl;
  resetFetchCalls();
  overrides = {
    readyFails: true,
    restart: () =>
      jsonResponse({ message: 'restarting', restarting: true, profiles: [], profilesToRemove: [], estimatedTime: 35 }),
  };
  const dialog = await clickRestartNow();

  // One second into a 35 s estimate. Against a fixed 30 s total the width would be negative, which
  // the style drops, leaving the bar empty until the countdown fell under 30.
  await within(dialog).findByText('Server restarting... 34s', undefined, { timeout: 2_000 });
  const fill = dialog.querySelector<HTMLElement>('.restart-progress-fill');
  assert.equal(fill?.style.width, `${(1 / 35) * 100}%`);
});

test(
  'services that failed to start are shown after the restart instead of reloading over them',
  { timeout: 15_000 },
  async () => {
    const { screen, fireEvent, within } = rtl;
    resetFetchCalls();
    const failure = 'Failed to start minio: image pull failed';
    overrides = {
      restart: () =>
        jsonResponse({
          message: 'restarting',
          restarting: true,
          profiles: ['minio'],
          profilesToRemove: [],
          estimatedTime: 5,
          orchestration: { success: false, message: 'Some services failed', errors: [failure] },
        }),
    };
    // jsdom cannot navigate, so a reload reports itself through console.error; count those.
    const navigations: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
      if (text.includes('navigation')) navigations.push(text);
      else consoleError(...args);
    };
    try {
      renderInfrastructure();
      await screen.findByText('Database Configuration');
      fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

      await within(dialog).findByText('Server ready', {}, { timeout: 5_000 });
      assert.ok(within(dialog).getByText(failure), 'the orchestration error is not shown');
      assert.ok(within(dialog).getByRole('button', { name: 'Reload Page' }), 'no way to reload after reading');
      assert.equal(
        within(dialog).queryByText('Server is back online! The page will reload automatically.') === null,
        true,
      );
      // Past the 2s after which a clean restart reloads the page.
      await new Promise(resolve => setTimeout(resolve, 2500));
      assert.deepEqual(navigations, [], 'the page reloaded over the warning');
    } finally {
      console.error = consoleError;
    }
  },
);

test(
  'services that failed to start stay on screen when the server never becomes ready',
  { timeout: 15_000 },
  async () => {
    const { screen, fireEvent, within } = rtl;
    const failure = 'Failed to start postgres: image pull failed';
    overrides = {
      readyFails: true,
      restart: () =>
        jsonResponse({
          message: 'restarting',
          restarting: true,
          profiles: ['postgres'],
          profilesToRemove: [],
          estimatedTime: 5,
          orchestration: { success: false, message: 'Some services failed', errors: [failure] },
        }),
    };
    renderInfrastructure();
    await screen.findByText('Database Configuration');
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
    const dialog = await screen.findByRole('dialog');
    // The readiness poll gives up after a minute of 1s retries; shorten only those waits. Every
    // lookup below passes its own timeout, since the default 1s one would be shortened too.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === 1000 || ms === 3000 ? 1 : ms, ...rest)) as typeof setTimeout;
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
      await within(dialog).findByText('Restart failed', {}, { timeout: 5_000 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.ok(within(dialog).getByText(failure), 'the failure that explains the restart is not shown');
  },
);

test('disabled database and storage are stopped beneath bundled host pins', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = {
    status: { ...RUNNING_BUNDLED, envPinned: ['DATABASE_HOST', 'S3_ENDPOINT'] },
    saved: READBACK_SAVED,
    savedAfterSave: {
      ...READBACK_SAVED,
      database: { ...READBACK_SAVED.database, type: 'sqlite', builtIn: false },
      storage: { ...READBACK_SAVED.storage, type: 'local', builtIn: false },
    },
    saveProfiles: ['redis'],
  };
  const { container } = renderInfrastructure();
  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="dbType"]')[0]);
  fireEvent.click(container.querySelectorAll<HTMLInputElement>('input[name="storageType"]')[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  assert.deepEqual(stopNames(dialog), ['openwa-postgres', 'openwa-minio']);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart')));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, {
    profiles: ['redis'],
    profilesToRemove: ['postgres', 'minio'],
  });
});

for (const cacheUsesRedis of [false, true]) {
  test(`a disabled Redis beneath its bundled host pin keeps an active cache: ${cacheUsesRedis}`, async () => {
    const { screen, waitFor, fireEvent, within } = rtl;
    resetFetchCalls();
    const profiles = ['postgres', 'minio', ...(cacheUsesRedis ? ['redis'] : [])];
    overrides = {
      status: { ...RUNNING_BUNDLED, envPinned: ['REDIS_HOST'] },
      saved: { ...READBACK_SAVED, queue: { enabled: false } },
      savedAfterSave: {
        ...READBACK_SAVED,
        redis: { ...READBACK_SAVED.redis, enabled: false },
        queue: { enabled: false },
      },
      saveProfiles: profiles,
    };
    const { container } = renderInfrastructure();
    await screen.findByText('Database Configuration');
    await awaitSeeded(container);
    fireEvent.click(toggleInput(container, 'Enable Redis'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
    const dialog = await screen.findByRole('dialog');
    assert.deepEqual(stopNames(dialog), cacheUsesRedis ? [] : ['openwa-redis']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
    await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart')));
    assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, {
      profiles,
      profilesToRemove: cacheUsesRedis ? [] : ['redis'],
    });
  });
}
