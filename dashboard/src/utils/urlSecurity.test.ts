import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalhostHost, resolveSocketUrl, warnIfInsecureHttpUrl } from './urlSecurity.ts';

test('isLocalhostHost recognizes loopback hosts', () => {
  assert.ok(isLocalhostHost('localhost'));
  assert.ok(isLocalhostHost('127.0.0.1'));
  assert.ok(isLocalhostHost('[::1]'));
  assert.ok(isLocalhostHost('::1'));
});

test('isLocalhostHost rejects non-loopback hosts', () => {
  assert.ok(!isLocalhostHost('gateway.example.com'));
  assert.ok(!isLocalhostHost('10.0.0.1'));
});

test('warnIfInsecureHttpUrl warns on non-localhost http', () => {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warns.push(msg);
  try {
    warnIfInsecureHttpUrl('http://gateway.example.com', 'VITE_API_URL');
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /insecure http/);
  assert.match(warns[0]!, /gateway\.example\.com/);
});

test('warnIfInsecureHttpUrl is silent on localhost http (dev)', () => {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warns.push(msg);
  try {
    warnIfInsecureHttpUrl('http://localhost:2785', 'VITE_API_URL');
    warnIfInsecureHttpUrl('http://127.0.0.1:2785', 'SOCKET_URL');
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 0);
});

test('warnIfInsecureHttpUrl is silent on https', () => {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warns.push(msg);
  try {
    warnIfInsecureHttpUrl('https://gateway.example.com', 'VITE_API_URL');
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 0);
});

test('warnIfInsecureHttpUrl returns the URL unchanged (does not throw)', () => {
  assert.equal(warnIfInsecureHttpUrl('http://gateway.example.com', 'x'), 'http://gateway.example.com');
});

test('resolveSocketUrl prefers VITE_WS_URL, then the API origin, then the page origin', () => {
  const page = 'https://dashboard.example.com';
  const api = 'https://api.example.com';
  assert.equal(resolveSocketUrl(undefined, '', page), page);
  assert.equal(resolveSocketUrl('', '', page), page);
  assert.equal(resolveSocketUrl(undefined, api, page), api);
  assert.equal(resolveSocketUrl('https://ws.example.com', api, page), 'https://ws.example.com');
});

test('resolveSocketUrl keeps only the origin of a VITE_API_URL that carries a path', () => {
  const page = 'https://dashboard.example.com';
  assert.equal(resolveSocketUrl(undefined, 'https://api.example.com/gw', page), 'https://api.example.com');
  assert.equal(resolveSocketUrl(undefined, 'https://api.example.com:8443/gw/v1', page), 'https://api.example.com:8443');
  // A relative value is a path on the page's own host.
  assert.equal(resolveSocketUrl(undefined, '/gw', page), page);
});

test('resolveSocketUrl keeps only the origin of VITE_WS_URL', () => {
  const page = 'https://dashboard.example.com';
  const api = 'https://api.example.com';
  // A trailing slash or a path would otherwise turn '/events' into an unknown namespace.
  assert.equal(resolveSocketUrl('https://ws.example.com/', api, page), 'https://ws.example.com');
  assert.equal(resolveSocketUrl('https://ws.example.com:8443/rt/', api, page), 'https://ws.example.com:8443');
});

test('resolveSocketUrl dials a scheme-less VITE_WS_URL on the page protocol, as socket.io did', () => {
  const page = 'https://dashboard.example.com';
  const api = 'https://api.example.com';
  assert.equal(resolveSocketUrl('localhost:2785', api, page), 'https://localhost:2785');
  assert.equal(resolveSocketUrl('ws.example.com:8443/', api, page), 'https://ws.example.com:8443');
  assert.equal(resolveSocketUrl('ws.example.com', api, page), 'https://ws.example.com');
  assert.equal(resolveSocketUrl('//ws.example.com/rt', api, page), 'https://ws.example.com');
  assert.equal(resolveSocketUrl('localhost:2785', api, 'http://localhost:5173'), 'http://localhost:2785');
});
