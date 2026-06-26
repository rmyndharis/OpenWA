// e2e boot environment. Set BEFORE AppModule is imported (setupFiles phase) so the
// app boots against local SQLite with no Redis/queue and no production boot guard.
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_TYPE = 'sqlite';
// Isolate the e2e data DB to a throwaway temp file so suites never pollute the developer's
// ./data/openwa.sqlite. e2e creates sessions/webhooks and doesn't self-clean, so without this they
// pile up across runs. Start each run from a fresh file.
const e2eDataDb = join(tmpdir(), `openwa-e2e-${process.pid}.sqlite`);
rmSync(e2eDataDb, { force: true });
process.env.DATABASE_NAME = e2eDataDb;
// Likewise isolate the auth/audit (main) DB, so e2e api-keys don't accumulate in ./data/main.sqlite.
const e2eMainDb = join(tmpdir(), `openwa-e2e-main-${process.pid}.sqlite`);
rmSync(e2eMainDb, { force: true });
process.env.MAIN_DATABASE_NAME = e2eMainDb;
process.env.QUEUE_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';
// Keep the auth/audit + data schema zero-config for the test boot.
process.env.MAIN_DATABASE_SYNCHRONIZE = 'true';
process.env.DATABASE_SYNCHRONIZE = 'true';
// e2e suites burst many requests at the API; relax the per-second rate limit so the
// ThrottlerGuard (still wired) doesn't 429 a normal test run.
process.env.RATE_LIMIT_SHORT_LIMIT = '100000';
process.env.RATE_LIMIT_MEDIUM_LIMIT = '100000';
process.env.RATE_LIMIT_LONG_LIMIT = '100000';
