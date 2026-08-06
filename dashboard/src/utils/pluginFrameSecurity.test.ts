import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_UI_CSP } from './pluginFrameSecurity.ts';

// The injection itself (injectConfigUiCsp) needs a DOM Document, which the node:test harness
// doesn't provide; the security decision lives entirely in the policy string, so that is what
// these tests pin down. The DOM wiring is a three-line prepend reviewed in Plugins.tsx.

const directives = new Map(
  CONFIG_UI_CSP.split(';').map(d => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name, values];
  }),
);

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

test('config-UI CSP leaves script-src to the inherited parent policy (nonce-based)', () => {
  assert.equal(directives.has('script-src'), false);
  assert.equal(directives.has('default-src'), false);
});
