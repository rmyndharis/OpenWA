// Render smoke test for the Logs page under the bare `node --test` runner, following the
// Sessions.test.ts harness (same providers, recorded-fetch stub, jsdom loader hooks). The Logs
// page is the AuditLog type's only consumer, and the wire type now carries required nullable
// fields (apiKeyId..statusCode are `| null`, userAgent/metadata added) — this pins that the page
// renders null fields with its fallbacks rather than crashing, and that the search filter matches
// action and errorMessage case-insensitively over rows whose other fields are null.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuditLog } from '../services/api';

// Every nullable field at its null floor: the pre-UI wire shape for actions that carry no session
// and no API-key linkage (infra admin operations).
const LOG_WITH_NULLS: AuditLog = {
  id: 'row-nulls',
  action: 'infra.restart',
  severity: 'info',
  apiKeyId: null,
  apiKeyName: null,
  sessionId: null,
  sessionName: null,
  ipAddress: null,
  userAgent: null,
  method: null,
  path: null,
  statusCode: null,
  errorMessage: null,
  metadata: null,
  createdAt: '2026-08-16T01:02:03.000Z',
};

const LOG_FAILED_SEND: AuditLog = {
  ...LOG_WITH_NULLS,
  id: 'row-failed',
  action: 'session.stop',
  severity: 'error',
  sessionId: 'sess-1',
  sessionName: 'billing-bot',
  ipAddress: '10.0.0.9',
  method: 'POST',
  path: '/api/sessions/sess-1/stop',
  statusCode: 502,
  errorMessage: 'SESSION_STOP_INCOMPLETE',
};

const LOGS = [LOG_WITH_NULLS, LOG_FAILED_SEND];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

// When set, the export's page walk (limit=200) fails with this status; the on-screen page still loads.
let exportFailure: number | null = null;
// When set, the export's page walk sees a table of this many rows, served 200 at a time.
let exportTotal: number | null = null;
// When set, every export page from this offset on is refused with a 429, as a tripped minute tier does.
let exportThrottledFrom: number | null = null;
// When set, the export walks a 300-row table that gains a newest row after its first page is read.
let exportGrowsMidWalk = false;
// When set, the export's page walk sees exactly these rows.
let exportRows: AuditLog[] | null = null;
// When set, the on-screen list reports this many rows in total, so the page has a pager.
let listTotal: number | null = null;
// When set, a request for the first on-screen page waits for it before answering.
let firstPageGate: Promise<void> | null = null;
// When set, the on-screen list read fails with this status.
let listFailure: number | null = null;

/** Row `i` of a table walked newest first; every row has its own id, as the gateway's rows do. */
function exportRow(i: number): AuditLog {
  return { ...LOG_FAILED_SEND, id: `row-${i}`, errorMessage: `err-${i}` };
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (exportFailure && url.includes('limit=200')) {
      return Promise.resolve(new Response(JSON.stringify({ message: 'boom' }), { status: exportFailure }));
    }
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') ?? 0);
    if (exportThrottledFrom !== null && url.includes('limit=200') && offset >= exportThrottledFrom) {
      return Promise.resolve(new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429 }));
    }
    if (exportTotal && url.includes('limit=200')) {
      const data = Array.from({ length: 200 }, (_, i) => exportRow(offset + i));
      return Promise.resolve(jsonResponse({ data, total: exportTotal }));
    }
    if (exportGrowsMidWalk && url.includes('limit=200')) {
      // The second page is read after a new row landed on top, so every older row sits one further down.
      if (offset === 0)
        return Promise.resolve(jsonResponse({ data: [...Array(200).keys()].map(exportRow), total: 300 }));
      const shifted = [exportRow(-1), ...[...Array(300).keys()].map(exportRow)];
      return Promise.resolve(jsonResponse({ data: shifted.slice(offset), total: 301 }));
    }
    if (exportRows && url.includes('limit=200')) {
      return Promise.resolve(jsonResponse({ data: exportRows, total: exportRows.length }));
    }
    if (listFailure && !url.includes('limit=200')) {
      return Promise.resolve(new Response(JSON.stringify({ message: 'Bad Gateway' }), { status: listFailure }));
    }
    // The gateway holds no error rows, so the server-side severity filter matches nothing.
    if (new URL(url, 'http://localhost').searchParams.get('severity') === 'error') {
      return Promise.resolve(jsonResponse({ data: [], total: 0 }));
    }
    const reply = jsonResponse({ data: LOGS, total: listTotal ?? LOGS.length });
    return firstPageGate && offset === 0 ? firstPageGate.then(() => reply) : Promise.resolve(reply);
  }) as typeof fetch;
}

/** Record the export's blobs instead of handing them to jsdom, which has no object URLs. */
function recordDownloads(): { downloads: Blob[]; restore: () => void } {
  const downloads: Blob[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    downloads.push(blob);
    return 'blob:export';
  };
  URL.revokeObjectURL = () => {};
  return {
    downloads,
    restore: () => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    },
  };
}

let rtl: typeof import('@testing-library/react');
let Logs: () => React.ReactElement;
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Logs } = await import('./Logs.tsx'));
});

afterEach(() => rtl.cleanup());

function renderLogs(gcTime?: number): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime } } });
  return rtl.render(
    createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, createElement(Logs))),
  ).container;
}

test('the log table renders rows whose nullable fields are null without crashing, and shows both severities', async () => {
  const container = renderLogs();
  await rtl.waitFor(() => {
    assert.ok(container.textContent?.includes('infra.restart'), 'null-floor row renders its action');
    assert.ok(container.textContent?.includes('session.stop'), 'populated row renders its action');
  });
  // The fallback for a null ip is an em-dash, not a crash and not the string "null".
  assert.ok(container.textContent?.includes('—'), 'null ip falls back to the dash placeholder');
  assert.ok(!container.textContent?.includes('null'), 'no raw null leaks into the DOM');
});

test('a failed full export is reported, and the rows on screen are not downloaded in its place', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  exportFailure = 500;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByText("Couldn't export the audit log");
    assert.equal(downloads.length, 0, 'the current page was downloaded as if it were the full export');
  } finally {
    exportFailure = null;
    restore();
  }
});

test('an export that stops at the row cap says so, counted in the UI language', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  // Stand in for a machine whose default locale groups digits with a dot, as de-DE does.
  const realToLocaleString = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ) {
    return realToLocaleString.call(this, locales ?? 'de-DE', options);
  };
  exportTotal = 60_000;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByText(/covers only the newest 10,000 entries/, {}, { timeout: 10_000 });
    assert.equal(downloads.length, 1, 'the rows fetched up to the cap are still downloaded');
  } finally {
    exportTotal = null;
    Number.prototype.toLocaleString = realToLocaleString;
    restore();
  }
});

test('an export stopped by the throttle says to wait, not to narrow the filter', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  exportTotal = 60_000;
  exportThrottledFrom = 400;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    // The walk retries the refused page after one second and after two more before it stops.
    await screen.findByText(/newest 400 entries because the gateway is rate-limiting/, {}, { timeout: 10_000 });
    assert.equal(
      screen.queryByText(/Narrow the severity filter/) === null,
      true,
      'the throttle was reported as the row cap',
    );
    assert.equal(downloads.length, 1, 'the rows fetched before the throttle are still downloaded');
  } finally {
    exportTotal = null;
    exportThrottledFrom = null;
    restore();
  }
});

test('an export whose search matches no entry says so and downloads nothing', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.change(screen.getByPlaceholderText('Search logs...'), { target: { value: 'no-such-action' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByText('No audit log entries match the search, so nothing was exported.');
    assert.equal(downloads.length, 0, 'an empty export was downloaded');
  } finally {
    restore();
  }
});

test('a truncated export whose search matches nothing names the entries it scanned', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  exportTotal = 60_000;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.change(screen.getByPlaceholderText('Search logs...'), { target: { value: 'no-such-action' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByText(/None of the newest 10,000 entries scanned match the search/, {}, { timeout: 10_000 });
    assert.equal(
      screen.queryByText(/The export covers only/) === null,
      true,
      'the warning reads as if a file was produced',
    );
    assert.equal(downloads.length, 0, 'an empty export was downloaded');
  } finally {
    exportTotal = null;
    restore();
  }
});

test('a row written while the export walks the pages is not exported twice', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { downloads, restore } = recordDownloads();
  exportGrowsMidWalk = true;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => assert.equal(downloads.length, 1));
    const lines = (await downloads[0].text()).split('\n');
    assert.equal(lines.length, 1 + 300, 'one header line and one line per distinct row');
    assert.equal(lines.filter(line => line.endsWith(',err-199')).length, 1, 'the row the shift repeated');
  } finally {
    exportGrowsMidWalk = false;
    restore();
  }
});

// Rows carry request paths and error messages a client chose, and a spreadsheet runs a cell that starts with = + - or @.
test('an exported cell that starts like a formula is neutralized', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { downloads, restore } = recordDownloads();
  exportRows = [
    { ...LOG_FAILED_SEND, id: 'row-formula', path: '=HYPERLINK("https://example.test","x")', errorMessage: '+cmd' },
  ];
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => assert.equal(downloads.length, 1));
    const csv = await downloads[0].text();
    assert.ok(csv.includes(`"'=HYPERLINK(""https://example.test"",""x"")"`), csv);
    assert.ok(csv.endsWith(",'+cmd"), csv);
  } finally {
    exportRows = null;
    restore();
  }
});

test('the table grid declares one column track per rendered cell', async () => {
  const container = renderLogs();
  await rtl.screen.findByText('infra.restart');
  const css = readFileSync(fileURLToPath(new URL('./Logs.css', import.meta.url)), 'utf8');
  const template = css.match(/\.logs-table \.table-row \{[^}]*grid-template-columns: ([^;]+);/)?.[1];
  assert.ok(template, 'the row grid template was not found');
  for (const row of container.querySelectorAll('.logs-table .table-row')) {
    assert.equal(template.split(/\s+/).length, row.children.length, template);
  }
});

test('typing a search on a later page keeps the search box mounted while page one loads', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listTotal = 60;
  let release!: () => void;
  try {
    // A zero gcTime drops page one from the cache as soon as page two replaces it, as the default
    // five minutes does for an operator who stays on a later page.
    renderLogs(0);
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => assert.equal(screen.getByRole('button', { name: '2' }).className, 'active'));
    await screen.findByText('infra.restart');
    await new Promise(resolve => setTimeout(resolve, 20));

    firstPageGate = new Promise(resolve => (release = resolve));
    const search = screen.getByPlaceholderText('Search logs...');
    fireEvent.change(search, { target: { value: 'sess' } });
    assert.ok(search.isConnected, 'the search box was replaced by the page spinner mid-typing');
    release();
    await screen.findByText('session.stop');
  } finally {
    listTotal = null;
    firstPageGate = null;
  }
});

test('a severity filter that matches nothing says no logs exist, not that this page has none', async () => {
  const { screen, fireEvent } = rtl;
  renderLogs();
  await screen.findByText('infra.restart');
  fireEvent.click(screen.getByRole('button', { name: 'Severity, All Severities' }));
  fireEvent.click(screen.getByRole('option', { name: 'Error' }));
  await screen.findByText('No logs match these filters. Adjust the severity filter to widen the search.');
  assert.ok(screen.getByRole('heading', { name: 'No logs found' }));
});

test('the severity badge shows the translated severity', async () => {
  const container = renderLogs();
  await rtl.screen.findByText('infra.restart');
  const badges = [...container.querySelectorAll('.severity-badge')].map(badge => badge.textContent);
  assert.deepEqual(badges, ['Info', 'Error']);
});

// A row's message is the only place some actions name what happened, such as the number and ids of a
// phone_second_lid_reported row, so it is shown with the action rather than only searched and exported.
test('a row shows its message under its action, and a row without one shows none', async () => {
  const container = renderLogs();
  const message = await rtl.screen.findByText('SESSION_STOP_INCOMPLETE');
  assert.equal(message.closest('.action')?.firstChild?.textContent, 'session.stop');
  const nullRow = [...container.querySelectorAll('.logs-table .action')].find(cell =>
    cell.textContent?.startsWith('infra.restart'),
  );
  assert.equal(nullRow?.textContent, 'infra.restart');
});

test('the search matches errorMessage as well as action, whatever the case', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderLogs();
  await screen.findByText('infra.restart');
  // Only LOG_FAILED_SEND's errorMessage ('SESSION_STOP_INCOMPLETE') holds this, and only case-insensitively.
  fireEvent.change(screen.getByPlaceholderText('Search logs...'), { target: { value: 'Stop_Incomplete' } });
  await waitFor(() => assert.ok(!screen.queryByText('infra.restart'), 'the search did not filter'));
  assert.ok(screen.queryByText('session.stop'), 'the errorMessage match was hidden');
});

test('a search of only spaces filters nothing, on screen or in the export', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { downloads, restore } = recordDownloads();
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.change(screen.getByPlaceholderText('Search logs...'), { target: { value: ' ' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(screen.queryByText('infra.restart'), 'a blank search hid the rows');
    assert.ok(screen.queryByText('session.stop'), 'a blank search hid the rows');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => assert.equal(downloads.length, 1));
    assert.equal((await downloads[0].text()).split('\n').length, 1 + LOGS.length, 'a blank search narrowed the export');
  } finally {
    restore();
  }
});

test('a search padded with spaces still matches', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderLogs();
  await screen.findByText('infra.restart');
  fireEvent.change(screen.getByPlaceholderText('Search logs...'), { target: { value: ' session ' } });
  await waitFor(() => assert.ok(!screen.queryByText('infra.restart'), 'the search did not filter'));
  assert.ok(screen.queryByText('session.stop'), 'the padded query matched nothing');
});

test('a failed read does not say that no logs exist', async () => {
  const { screen } = rtl;
  listFailure = 502;
  try {
    renderLogs();
    await screen.findByRole('alert');
    assert.ok(!screen.queryByText('No logs found'), 'a read that failed was reported as an empty history');
    assert.ok(
      !screen.queryByText(/Audit logs will appear here/),
      'a read that failed was reported as an empty history',
    );
  } finally {
    listFailure = null;
  }
});
