import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalhostHost, warnIfInsecureHttpUrl } from './urlSecurity.ts';

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
