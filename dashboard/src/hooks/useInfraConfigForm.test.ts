// The Infrastructure form's seeding and the payload a save sends, driven through renderHook so a test decides
// which of the two server reads is in, and when. Infrastructure.test.ts covers the same hook through the page.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { InfraStatus, SavedConfig } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';
import type { useInfraConfigForm as useInfraConfigFormFn } from './useInfraConfigForm.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useInfraConfigForm: typeof useInfraConfigFormFn;

before(async () => {
  const { installJsdomGlobals } = (await import('../test-helpers/jsdom.ts')) as {
    installJsdomGlobals: typeof installJsdomGlobalsFn;
  };
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ useInfraConfigForm } = await import('./useInfraConfigForm.ts'));
});

afterEach(() => rtl.cleanup());

interface Reads {
  status?: InfraStatus;
  saved?: SavedConfig;
}

function renderForm(initial: Reads) {
  return rtl.renderHook(({ status, saved }: Reads) => useInfraConfigForm(status, saved), { initialProps: initial });
}

// What the gateway process runs: SQLite, local media, no Redis, no queue.
const RUNNING: InfraStatus = {
  database: { connected: true, type: 'sqlite', host: 'localhost', builtIn: false },
  redis: { enabled: false, connected: false, host: 'localhost', port: 6379, builtIn: false },
  queue: { enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } },
  storage: { type: 'local', path: './data/media', builtIn: false },
  engine: { type: 'whatsapp-web.js', headless: true },
};

// What the operator saved afterwards and has not restarted for: external PostgreSQL, Redis with the queue, S3.
const SAVED: SavedConfig = {
  database: {
    type: 'postgres',
    builtIn: false,
    builtInSet: true,
    host: 'pg.internal',
    port: '5433',
    username: 'openwa',
    database: 'openwa_prod',
    schema: 'app',
    poolSize: 20,
    sslEnabled: true,
    sslRejectUnauthorized: false,
    passwordSet: true,
  },
  redis: { enabled: true, builtIn: false, builtInSet: true, host: 'redis.internal', port: '6380', passwordSet: true },
  queue: { enabled: true },
  storage: {
    type: 's3',
    builtIn: false,
    builtInSet: true,
    localPath: '',
    s3Bucket: 'media',
    s3Region: 'eu-west-1',
    s3Endpoint: 'https://s3.internal',
    s3CredentialsSet: true,
  },
  engine: { type: 'whatsapp-web.js', headless: true, sessionDataPath: './data/sessions', browserArgs: '' },
};

test('a save after a reload keeps the selections that were saved and are waiting for a restart', () => {
  const { result } = renderForm({ status: RUNNING, saved: SAVED });

  const { database, redis, queue, storage } = result.current.buildSavePayload();

  assert.deepEqual(
    {
      database: database?.type,
      host: database?.host,
      redis: redis?.enabled,
      queue: queue?.enabled,
      storage: storage?.type,
      bucket: storage?.s3Bucket,
    },
    { database: 'postgres', host: 'pg.internal', redis: true, queue: true, storage: 's3', bucket: 'media' },
  );
});

// A running service that differs from the saved one still drives the live indicators, but the form is
// the saved choice: a save of an unrelated field must not write the running one back over it.
test('the form shows what was saved, not what runs', () => {
  const { result } = renderForm({ status: RUNNING, saved: SAVED });

  assert.equal(result.current.dbConfig.type, 'postgres');
  assert.equal(result.current.redisEnabled, true);
  assert.equal(result.current.queueEnabled, true);
  assert.equal(result.current.storageConfig.type, 's3');
});

const RUNNING_OLD: InfraStatus = {
  ...RUNNING,
  database: { ...RUNNING.database, type: 'postgres', host: 'old-running-db' },
  redis: { ...RUNNING.redis, enabled: true, host: 'old-running-redis', port: 6379 },
  storage: { ...RUNNING.storage, path: '/old/media' },
};
const SAVED_NEW: SavedConfig = {
  ...SAVED,
  database: { ...SAVED.database, host: 'new-saved-db' },
  redis: { ...SAVED.redis, host: 'new-saved-redis', port: '6380' },
  storage: { ...SAVED.storage, type: 'local', localPath: '/new/media' },
};

// /config is a file read and /status probes every backend, so which one settles last is not the page's to choose.
for (const order of ['status first', 'config first', 'together'] as const) {
  test(`the saved host, port and media path win when the reads settle ${order}`, () => {
    const initial: Reads =
      order === 'status first'
        ? { status: RUNNING_OLD }
        : order === 'config first'
          ? { saved: SAVED_NEW }
          : { status: RUNNING_OLD, saved: SAVED_NEW };
    const { result, rerender } = renderForm(initial);
    rerender({ status: RUNNING_OLD, saved: SAVED_NEW });

    const { database, redis, storage } = result.current.buildSavePayload();

    assert.deepEqual(
      { dbHost: database?.host, redisHost: redis?.host, redisPort: redis?.port, localPath: storage?.localPath },
      { dbHost: 'new-saved-db', redisHost: 'new-saved-redis', redisPort: '6380', localPath: '/new/media' },
    );
  });
}

test('a host, port and path nothing has saved are seeded from what runs', () => {
  // GET /config reports '' for a key the file does not hold.
  const unsaved: SavedConfig = {
    ...SAVED_NEW,
    database: { ...SAVED_NEW.database, host: '', port: '' },
    redis: { ...SAVED_NEW.redis, host: '', port: '' },
    storage: { ...SAVED_NEW.storage, localPath: '' },
  };
  const { result } = renderForm({ status: RUNNING_OLD, saved: unsaved });

  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual(
    {
      dbHost: database?.host,
      dbPort: database?.port,
      redisHost: redis?.host,
      redisPort: redis?.port,
      path: storage?.localPath,
    },
    { dbHost: 'old-running-db', dbPort: '5432', redisHost: 'old-running-redis', redisPort: '6379', path: '/old/media' },
  );
});

// Bundled containers run now; the operator saved external services and has not restarted.
const RUNNING_BUILTIN: InfraStatus = {
  database: { connected: true, type: 'postgres', host: 'postgres', builtIn: true },
  redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true },
  queue: { enabled: true, webhooks: { pending: 0, completed: 0, failed: 0 } },
  storage: { type: 's3', bucket: 'openwa', builtIn: true },
  engine: { type: 'whatsapp-web.js', headless: true },
};

// The operator saved bundled containers and has not restarted: external services run now.
const STORED_BUILTIN: SavedConfig = {
  ...SAVED,
  database: { ...SAVED.database, builtIn: true },
  redis: { ...SAVED.redis, builtIn: true },
  storage: { ...SAVED.storage, builtIn: true },
};

const shownFlags = (form: ReturnType<typeof renderForm>['result']['current']) => [
  form.dbConfig.builtIn,
  form.redisConfig.builtIn,
  form.storageConfig.builtIn,
];

// A service whose mode the config does not state (a host pinned in .env, or the first-boot defaults): /config answers
// builtInSet false, and only /status knows a bundled container runs.
const UNSTORED_BUILTIN: SavedConfig = {
  ...SAVED,
  database: { ...SAVED.database, builtIn: false, builtInSet: false },
  redis: { ...SAVED.redis, builtIn: false, builtInSet: false },
  storage: { ...SAVED.storage, builtIn: false, builtInSet: false },
};

// The toggles are the saved choice like every other selection. Shown from what runs, one that reads "external"
// invites typing an external host and credentials that the gateway then drops under the stored bundled mode.
test('the built-in toggles show what was saved, not what runs', () => {
  const external = renderForm({ status: RUNNING_BUILTIN, saved: SAVED });
  assert.deepEqual(shownFlags(external.result.current), [false, false, false]);
  rtl.cleanup();

  const bundled = renderForm({ status: RUNNING, saved: STORED_BUILTIN });
  assert.deepEqual(shownFlags(bundled.result.current), [true, true, true]);
});

for (const order of ['status first', 'config first'] as const) {
  test(`the built-in toggles show what was saved when the reads settle ${order}`, () => {
    const { result, rerender } = renderForm(order === 'status first' ? { status: RUNNING } : { saved: STORED_BUILTIN });
    rerender({ status: RUNNING, saved: STORED_BUILTIN });

    assert.deepEqual(shownFlags(result.current), [true, true, true]);
  });
}

test('a built-in flag nothing stores follows what runs, so a save does not claim a switch', () => {
  const { result } = renderForm({ status: RUNNING_BUILTIN, saved: UNSTORED_BUILTIN });

  assert.deepEqual(shownFlags(result.current), [true, true, true]);
  const { database, redis, storage } = result.current.buildSavePayload();
  assert.deepEqual([database?.builtIn, redis?.builtIn, storage?.builtIn], [true, true, true]);
});

for (const order of ['status first', 'config first'] as const) {
  test(`a built-in flag nothing stores follows what runs when the reads settle ${order}`, () => {
    const { result, rerender } = renderForm(
      order === 'status first' ? { status: RUNNING_BUILTIN } : { saved: UNSTORED_BUILTIN },
    );
    rerender({ status: RUNNING_BUILTIN, saved: UNSTORED_BUILTIN });

    assert.deepEqual(shownFlags(result.current), [true, true, true]);
  });
}

test('each built-in flag is judged on its own: a stored one wins, an unstored one follows what runs', () => {
  const mixed: SavedConfig = {
    ...UNSTORED_BUILTIN,
    database: { ...SAVED.database, builtIn: false, builtInSet: true },
    storage: { ...SAVED.storage, builtIn: true, builtInSet: true },
  };
  const { result } = renderForm({ status: RUNNING_BUILTIN, saved: mixed });

  assert.deepEqual(shownFlags(result.current), [false, true, true]);
});

test('a save carries the built-in flag the form shows', () => {
  for (const [status, saved] of [
    [RUNNING_BUILTIN, SAVED],
    [RUNNING, STORED_BUILTIN],
  ] as const) {
    const { result } = renderForm({ status, saved });
    rtl.act(() => result.current.updateDbConfig('host', 'db.external.example'));

    const { database, redis, storage } = result.current.buildSavePayload();

    assert.deepEqual([database?.builtIn, redis?.builtIn, storage?.builtIn], shownFlags(result.current));
    rtl.cleanup();
  }
});

test('external values typed after flipping a stored bundled container off are saved with the external flag', () => {
  const { result } = renderForm({ status: RUNNING, saved: STORED_BUILTIN });
  rtl.act(() => {
    result.current.updateDbConfig('builtIn', false);
    result.current.updateDbConfig('host', 'db.external.example');
    result.current.updateStorageConfig('builtIn', false);
    result.current.updateStorageConfig('s3Bucket', 'ext-bucket');
  });

  const { database, storage } = result.current.buildSavePayload();

  assert.deepEqual(
    [database?.builtIn, database?.host, storage?.builtIn, storage?.s3Bucket],
    [false, 'db.external.example', false, 'ext-bucket'],
  );
});

test('a bundled container never gets a typed password', () => {
  const { result } = renderForm({ status: RUNNING, saved: STORED_BUILTIN });
  rtl.act(() => {
    result.current.updateDbConfig('password', 'typed-db-secret');
    result.current.updateRedisConfig('password', 'typed-redis-secret');
  });

  const { database, redis } = result.current.buildSavePayload();

  assert.deepEqual([database?.password, redis?.password], ['', '']);
});

test('a refetch after the form is seeded does not overwrite an edit in progress', () => {
  const { result, rerender } = renderForm({ status: RUNNING, saved: SAVED });
  rtl.act(() => result.current.updateDbConfig('host', 'edited-host'));

  rerender({
    status: { ...RUNNING },
    saved: { ...SAVED, database: { ...SAVED.database, host: 'refetched-host' } },
  });

  assert.equal(result.current.buildSavePayload().database?.host, 'edited-host');
});

// The bundled container runs without TLS, so turning Use Built-in on over an external database saved with SSL sends
// SSL off; off again, the card's own setting goes out. Beside a host the environment pins elsewhere the next boot
// keeps dialling that server, whose setting stays as shown.
test('a built-in database is saved with SSL off', () => {
  const { result } = renderForm({ status: RUNNING, saved: SAVED });
  rtl.act(() => result.current.updateDbConfig('builtIn', true));
  assert.equal(result.current.buildSavePayload().database?.sslEnabled, false);
  rtl.act(() => result.current.updateDbConfig('builtIn', false));
  assert.equal(result.current.buildSavePayload().database?.sslEnabled, true);
});

test('beside a host pinned elsewhere a built-in database keeps the SSL setting shown', () => {
  const { result } = renderForm({ status: { ...RUNNING, envPinned: ['DATABASE_HOST'] }, saved: SAVED });
  rtl.act(() => result.current.updateDbConfig('builtIn', true));
  assert.equal(result.current.buildSavePayload().database?.sslEnabled, true);
});

// parseInt('') is NaN, which JSON writes as null, and the gateway refuses a null pool size.
test('an emptied pool size is left out of the save instead of going out as null', () => {
  const { result } = renderForm({ status: RUNNING, saved: SAVED });
  rtl.act(() => result.current.updateDbConfig('poolSize', NaN));

  const sent = JSON.parse(JSON.stringify(result.current.buildSavePayload())) as { database: Record<string, unknown> };

  assert.ok(!('poolSize' in sent.database), `poolSize went out as ${JSON.stringify(sent.database.poolSize)}`);
});

// The gateway stores any non-negative integer, so a value outside the field's 1 to 50 hint is what was saved
// and goes back unchanged on a save of something else.
test('a stored pool size outside the field range is saved as stored', () => {
  const stored: SavedConfig = { ...SAVED, database: { ...SAVED.database, poolSize: 100 } };
  const { result } = renderForm({ status: RUNNING, saved: stored });

  assert.equal(result.current.buildSavePayload().database?.poolSize, 100);
});

// /config reports a pinned selection as the effective value, so the form shows the pin. Sending it back would write the
// pin over the stored choice and drop the stored settings of the other mode; untouched, it is left out.
const PINNED_SELECTIONS: InfraStatus = { ...RUNNING, envPinned: ['DATABASE_TYPE', 'STORAGE_TYPE', 'REDIS_ENABLED'] };

test('a selection the environment pins is left out of a save until the operator changes it', () => {
  const { result } = renderForm({ status: PINNED_SELECTIONS, saved: SAVED });

  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.type, redis?.enabled, storage?.type], [undefined, undefined, undefined]);
  // The rest of each section still goes out.
  assert.deepEqual([database?.host, redis?.host, storage?.s3Bucket], ['pg.internal', 'redis.internal', 'media']);
});

test('a pinned selection the operator changes is sent, and an unpinned one always is', () => {
  const { result } = renderForm({ status: PINNED_SELECTIONS, saved: SAVED });

  rtl.act(() => {
    result.current.updateDbConfig('type', 'sqlite');
    result.current.updateStorageConfig('type', 'local');
    result.current.setRedisEnabled(false);
  });
  const changed = result.current.buildSavePayload();
  assert.deepEqual([changed.database?.type, changed.redis?.enabled, changed.storage?.type], ['sqlite', false, 'local']);

  const unpinned = renderForm({ status: RUNNING, saved: SAVED }).result.current.buildSavePayload();
  assert.deepEqual(
    [unpinned.database?.type, unpinned.redis?.enabled, unpinned.storage?.type],
    ['postgres', true, 's3'],
  );
});

test('one pinned selection is left out without the others', () => {
  const { result } = renderForm({ status: { ...RUNNING, envPinned: ['STORAGE_TYPE'] }, saved: SAVED });

  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.type, redis?.enabled, storage?.type], ['postgres', true, undefined]);
});

// An edited field of a pinned database or storage card belongs to the pinned mode, so the save names that mode:
// applied to a stored selection of the other mode, the edit would be dropped. The Redis switch needs no such rule,
// as the gateway saves the Redis fields whatever the switch.
test('editing a field of a pinned database or storage card sends its type, a Redis field keeps the switch out', () => {
  const { result } = renderForm({ status: PINNED_SELECTIONS, saved: SAVED });

  rtl.act(() => {
    result.current.updateDbConfig('sslEnabled', false);
    result.current.updateStorageConfig('s3Bucket', 'media-2');
    result.current.updateRedisConfig('host', 'redis-2.internal');
  });
  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.type, redis?.enabled, storage?.type], ['postgres', undefined, 's3']);
});

// A pinned host decides the built-in mode at every boot, so the flag the toggle shows is no choice either. Sent, a
// flag of true writes the bundled credentials over stored ones the pinned host may still need; untouched, it is left
// out and the gateway keeps the stored flag.
const PINNED_HOSTS: InfraStatus = { ...RUNNING, envPinned: ['DATABASE_HOST', 'REDIS_HOST', 'S3_ENDPOINT'] };

test('a built-in flag beside a pinned host is left out of a save until its toggle is used', () => {
  const { result } = renderForm({ status: PINNED_HOSTS, saved: SAVED });

  const untouched = result.current.buildSavePayload();
  assert.deepEqual(
    [untouched.database?.builtIn, untouched.redis?.builtIn, untouched.storage?.builtIn],
    [undefined, undefined, undefined],
  );

  rtl.act(() => {
    result.current.updateDbConfig('builtIn', true);
    result.current.updateRedisConfig('builtIn', true);
    result.current.updateStorageConfig('builtIn', true);
  });
  const touched = result.current.buildSavePayload();
  assert.deepEqual([touched.database?.builtIn, touched.redis?.builtIn, touched.storage?.builtIn], [true, true, true]);
});

// The hosts pinned to the bundled containers, in some of the spellings that reach them.
const SAVED_PINNED_BUNDLED: SavedConfig = {
  ...SAVED,
  database: { ...SAVED.database, builtIn: true, builtInSet: false, host: 'openwa-postgres' },
  redis: { ...SAVED.redis, builtIn: true, builtInSet: false, host: 'REDIS' },
  storage: { ...SAVED.storage, builtIn: true, builtInSet: false, s3Endpoint: 'http://minio:9000/' },
};

test('another edit in the card keeps a built-in flag beside a host pinned to the bundled container out', () => {
  const { result } = renderForm({ status: PINNED_HOSTS, saved: SAVED_PINNED_BUNDLED });

  rtl.act(() => {
    result.current.updateDbConfig('sslEnabled', false);
    result.current.updateRedisConfig('port', '6390');
    result.current.updateStorageConfig('s3Bucket', 'media-2');
  });
  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.builtIn, redis?.builtIn, storage?.builtIn], [undefined, undefined, undefined]);
});

// Beside a host pinned to another server the card shows that server, and its fields are what an edit changes: the
// flag the card shows goes with them, so the gateway applies them instead of a stored built-in mode. Untouched, the
// flag stays out and the stored mode is kept.
test('an edit in the card beside a host pinned elsewhere sends the flag the card shows', () => {
  const { result } = renderForm({ status: PINNED_HOSTS, saved: SAVED });

  const untouched = result.current.buildSavePayload();
  assert.deepEqual(
    [untouched.database?.builtIn, untouched.redis?.builtIn, untouched.storage?.builtIn],
    [undefined, undefined, undefined],
  );
  rtl.act(() => {
    result.current.updateDbConfig('username', 'app');
    result.current.updateRedisConfig('port', '6390');
    result.current.updateStorageConfig('s3Bucket', 'media-2');
  });
  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.builtIn, redis?.builtIn, storage?.builtIn], [false, false, false]);
});

// Choosing the service in the form is a new selection, and its built-in mode is part of it: the stored flag belongs to
// the selection being left (the first boot writes it false next to SQLite), so the flag the toggle shows is sent.
test('a built-in flag beside a pinned host is sent with a selection the form changes', () => {
  const sqliteSaved: SavedConfig = {
    ...SAVED,
    database: { ...SAVED.database, type: 'sqlite', builtIn: true, builtInSet: false },
    redis: { ...SAVED.redis, enabled: false, builtIn: true, builtInSet: false },
    storage: { ...SAVED.storage, type: 'local', builtIn: true, builtInSet: false },
  };
  // The bundled containers run on the pinned hosts, so the toggles read on.
  const status: InfraStatus = {
    ...PINNED_HOSTS,
    database: { ...PINNED_HOSTS.database, host: 'postgres', builtIn: true },
    redis: { ...PINNED_HOSTS.redis, host: 'redis', builtIn: true },
    storage: { ...PINNED_HOSTS.storage, builtIn: true },
  };
  const { result } = renderForm({ status, saved: sqliteSaved });

  rtl.act(() => {
    result.current.updateDbConfig('type', 'postgres');
    result.current.setRedisEnabled(true);
    result.current.updateStorageConfig('type', 's3');
  });
  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.builtIn, redis?.builtIn, storage?.builtIn], [true, true, true]);
});
