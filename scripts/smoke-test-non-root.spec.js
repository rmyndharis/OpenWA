/**
 * Unit tests for scripts/smoke-test-non-root.sh (node:test). Run: `npm run test:scripts`.
 *
 * The script boots the gateway with the hardening docker-compose.yml gives the openwa-api service. The
 * flags are written out in the script, so a capability added to or dropped from compose (or a changed
 * read-only root, tmpfs, security option or limit) has to reach the script as well, or the smoke test
 * passes an image that fails on an operator's `docker compose up`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(__dirname, 'smoke-test-non-root.sh'), 'utf8');
const API = yaml.load(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')).services['openwa-api'];

const VALUE_FLAGS = new Set(['--tmpfs', '--cap-drop', '--cap-add', '--security-opt', '--pids-limit', '--memory']);

/** `--flag value` and bare `--flag` words as sorted pairs, so the order the flags are written in does not matter. */
function pairs(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    out.push(VALUE_FLAGS.has(words[i]) ? `${words[i]} ${words[++i]}` : words[i]);
  }
  return out.sort();
}

/** The value compose runs with when the variable is unset: `${OPENWA_PIDS_LIMIT:-2048}` gives 2048. */
const composeDefault = value => String(value).replace(/^\$\{[A-Z0-9_]+:-([^}]*)\}$/, '$1');

test('the boot flags match the hardening of the openwa-api compose service', () => {
  const listed = /^API_HARDENING="([^"]*)"$/m.exec(SCRIPT);
  assert.ok(listed, 'smoke-test-non-root.sh no longer defines API_HARDENING');
  const expected = [
    ...(API.read_only ? ['--read-only'] : []),
    ...(API.tmpfs ?? []).flatMap(mount => ['--tmpfs', mount]),
    ...(API.cap_drop ?? []).flatMap(cap => ['--cap-drop', cap]),
    ...(API.cap_add ?? []).flatMap(cap => ['--cap-add', cap]),
    ...(API.security_opt ?? []).flatMap(opt => ['--security-opt', opt]),
    ...(API.pids_limit === undefined ? [] : ['--pids-limit', composeDefault(API.pids_limit)]),
    ...(API.mem_limit === undefined ? [] : ['--memory', composeDefault(API.mem_limit)]),
  ];
  assert.deepEqual(pairs(listed[1].split(/\s+/)), pairs(expected));
});

test('the gateway boot uses those flags', () => {
  assert.match(SCRIPT, /^BOOT_CONTAINER=\$\(docker run -d \$API_HARDENING /m);
});
