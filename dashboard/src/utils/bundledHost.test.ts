import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namesBundledContainer, sameHost } from './bundledHost.ts';
import { namesBundledContainer as serverRule } from '../../../src/modules/docker/bundled-host.ts';
import { HOST_SPELLINGS, type ServiceName } from '../../../test/fixtures/builtin-mode-cases.ts';

const PROFILE: Record<ServiceName, string> = { database: 'postgres', redis: 'redis', storage: 'minio' };
// Names every object inherits, which are no profile.
const INHERITED = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

// Every host spelling the shared table lists, plus generated ones: letter cases, trailing dots and spaces around the
// alias, the container name and a few other names, bare and inside endpoint URLs.
function candidates(): string[] {
  const names = ['postgres', 'redis', 'minio', 'openwa-postgres', 'openwa-redis', 'openwa-minio', 'localhost', 'db.x'];
  const cases = (n: string) => [n, n.toUpperCase(), n[0].toUpperCase() + n.slice(1)];
  const hosts = names.flatMap(cases).flatMap(h => ['', '.', '..', ' ', '. '].map(tail => h + tail));
  const urls = hosts.flatMap(h =>
    ['http://', 'https://', 'HTTP://'].flatMap(scheme =>
      ['', ':9000', ':9000/', '/bucket'].map(rest => `${scheme}${h.trim()}${rest}`),
    ),
  );
  const listed = Object.values(HOST_SPELLINGS).flatMap(s => [...s.reach, ...s.elsewhere]);
  const inherited = INHERITED.flatMap(n => [n, `openwa-${n}`, `http://${n}:9000`]);
  return [...new Set([...listed, ...hosts, ...urls, ...inherited, '', ' ', 'not a url'])];
}

test('the page reads every host spelling the way the server does', () => {
  const values = candidates();
  let compared = 0;
  for (const profile of ['postgres', 'redis', 'minio', 'other', ...INHERITED]) {
    for (const value of [...values, undefined]) {
      assert.equal(
        namesBundledContainer(profile, value),
        serverRule(profile, value),
        `${profile} ${JSON.stringify(value)}`,
      );
      compared++;
    }
  }
  assert.ok(compared > 1000, `only ${compared} cases`);
});

test('the shared spellings reach the bundled container, the others do not', () => {
  for (const [service, { reach, elsewhere }] of Object.entries(HOST_SPELLINGS) as [
    ServiceName,
    typeof HOST_SPELLINGS.database,
  ][]) {
    for (const host of reach) assert.ok(namesBundledContainer(PROFILE[service], host), `${service} ${host}`);
    for (const host of elsewhere) assert.ok(!namesBundledContainer(PROFILE[service], host), `${service} ${host}`);
  }
});

test('a name every object inherits is no profile, on the page and on the server', () => {
  for (const name of INHERITED) {
    for (const host of [name, `openwa-${name}`]) {
      assert.equal(namesBundledContainer(name, host), false, `page ${name} ${host}`);
      assert.equal(serverRule(name, host), false, `server ${name} ${host}`);
    }
  }
});

test('two spellings of the bundled container are the same host, other hosts only when equal', () => {
  assert.ok(sameHost('postgres', 'postgres', 'OpenWA-Postgres.'));
  assert.ok(sameHost('minio', 'http://minio:9000', 'http://MINIO:9000/'));
  assert.ok(sameHost('postgres', 'db.example.com', 'db.example.com'));
  assert.ok(!sameHost('postgres', 'db.example.com', 'DB.example.com'));
  assert.ok(!sameHost('postgres', 'postgres', 'db.example.com'));
  assert.ok(!sameHost('redis', undefined, 'redis'));
});
