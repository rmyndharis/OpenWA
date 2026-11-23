import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_UI_CSP, hardenConfigUiHtml } from './pluginFrameSecurity.ts';

const directives = new Map(
  CONFIG_UI_CSP.split(';').map(d => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name, values];
  }),
);

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
});

afterEach(() => {
  document.head.querySelectorAll('meta[name="openwa-csp-nonce"]').forEach(el => el.remove());
});

test('config-UI CSP restricts images to same-origin or inline data:', () => {
  assert.deepEqual(directives.get('img-src'), ["'self'", 'data:']);
});

test('config-UI CSP restricts audio/video to same-origin or inline data:', () => {
  assert.deepEqual(directives.get('media-src'), ["'self'", 'data:']);
});

test('config-UI CSP forbids network connections (postMessage bridge is the only channel)', () => {
  assert.deepEqual(directives.get('connect-src'), ["'none'"]);
});

test('config-UI CSP forbids form submissions (no exfiltration via form posts)', () => {
  assert.deepEqual(directives.get('form-action'), ["'none'"]);
});

test('config-UI CSP contains no wildcard remote origin anywhere', () => {
  assert.ok(!CONFIG_UI_CSP.includes('https:'), 'bare https: scheme source re-opens egress');
  assert.ok(!CONFIG_UI_CSP.includes('http:'), 'bare http: scheme source re-opens egress');
  assert.ok(!CONFIG_UI_CSP.includes('*'), 'wildcard host source re-opens egress');
});

test('config-UI CSP restricts script-src to unsafe-inline only (blocking external scripts even with a nonce)', () => {
  assert.deepEqual(directives.get('script-src'), ["'unsafe-inline'"]);
  assert.equal(directives.has('default-src'), false);
});

test('hardenConfigUiHtml stamps nonce on inline scripts and skips HTML src and SVG href/xlink:href scripts', () => {
  const source = [
    '<!doctype html><html><head><title>UI</title></head><body>',
    '<script id="html-inline">window.a = 1;</script>',
    '<script id="html-ext" src="https://evil.example/a.js"></script>',
    '<svg><script id="svg-inline">window.b = 2;</script></svg>',
    '<svg><script id="svg-href" href="https://evil.example/b.js"></script></svg>',
    '<svg><script id="svg-href-upper" HREF="https://evil.example/c.js"></script></svg>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><script id="svg-xlink" xlink:href="https://evil.example/d.js"></script></svg>',
    '<svg><script id="svg-xlink-bare" xlink:href="https://evil.example/e.js"></script></svg>',
    '</body></html>',
  ].join('');

  const hardened = hardenConfigUiHtml(source, 'nonce-xyz');
  const parsed = new DOMParser().parseFromString(hardened, 'text/html');

  assert.equal(parsed.getElementById('html-inline')?.getAttribute('nonce'), 'nonce-xyz');
  assert.equal(parsed.getElementById('svg-inline')?.getAttribute('nonce'), 'nonce-xyz');
  assert.equal(parsed.getElementById('html-ext')?.getAttribute('nonce'), null);
  assert.equal(parsed.getElementById('svg-href')?.getAttribute('nonce'), null);
  assert.equal(parsed.getElementById('svg-href-upper')?.getAttribute('nonce'), null);
  assert.equal(parsed.getElementById('svg-xlink')?.getAttribute('nonce'), null);
  assert.equal(parsed.getElementById('svg-xlink-bare')?.getAttribute('nonce'), null);

  const firstHeadEl = parsed.head.firstElementChild as HTMLMetaElement | null;
  assert.equal(firstHeadEl?.tagName, 'META');
  assert.equal(firstHeadEl?.httpEquiv, 'Content-Security-Policy');
  assert.equal(firstHeadEl?.content, CONFIG_UI_CSP);
});

test('hardenConfigUiHtml reads openwa-csp-nonce meta when nonce arg is omitted and skips placeholder or blank', () => {
  const source = '<html><body><script id="s">1</script></body></html>';

  const meta = document.createElement('meta');
  meta.name = 'openwa-csp-nonce';
  meta.content = 'meta-nonce-1';
  document.head.appendChild(meta);

  const fromMeta = new DOMParser().parseFromString(hardenConfigUiHtml(source), 'text/html');
  assert.equal(fromMeta.getElementById('s')?.getAttribute('nonce'), 'meta-nonce-1');

  meta.content = '__OPENWA_CSP_NONCE__';
  const fromPlaceholder = new DOMParser().parseFromString(hardenConfigUiHtml(source), 'text/html');
  assert.equal(fromPlaceholder.getElementById('s')?.getAttribute('nonce'), null);
  assert.equal(fromPlaceholder.head.firstElementChild?.getAttribute('content'), CONFIG_UI_CSP);

  meta.content = 'meta-nonce-1';
  const explicitBlank = new DOMParser().parseFromString(hardenConfigUiHtml(source, ''), 'text/html');
  assert.equal(explicitBlank.getElementById('s')?.getAttribute('nonce'), null);
});
