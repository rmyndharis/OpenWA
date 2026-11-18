import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * restore.sh refuses a SQLite archive while DATABASE_TYPE is postgres, wherever the setting comes from: the
 * environment, ./.env or an .env.generated. The migration guide's hazard row tells the operator how to run on SQLite
 * again, and the way out has to name the layer that holds the setting: an environment value outranks ./.env, so
 * editing ./.env does not lift the refusal when the environment (a compose environment: entry, a Helm ConfigMap the
 * helper pod takes with envFrom) is what says postgres.
 */
const repoRoot = path.resolve(__dirname, '../..');

/**
 * The Action cell of the hazard row for the refusal. The row is found by its text, not by `next`: the Release cell
 * names the version once the release is cut.
 */
function hazardRowAction(): string {
  const doc = fs.readFileSync(path.join(repoRoot, 'docs/14-migration-guide.md'), 'utf8');
  const row = doc
    .split('\n')
    .find(
      line =>
        line.startsWith('|') &&
        line.includes('`restore.sh` exits `1`') &&
        line.includes('`DATABASE_TYPE` is `postgres`'),
    );
  if (row === undefined) throw new Error('the hazard row for the restore refusal is not in docs/14');
  return row.split('|')[3];
}

describe('the way out of the restore.sh DATABASE_TYPE refusal', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-restore-remedy-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is not lifted by ./.env alone while the environment says postgres', () => {
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'main.sqlite'), 'main');
    fs.writeFileSync(path.join(stage, 'openwa.sqlite'), 'data');
    const archive = path.join(dir, 'archive.tar.gz');
    expect(spawnSync('tar', ['-czf', archive, '-C', stage, '.']).status).toBe(0);
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    // What the hazard row used to prescribe on its own: DATABASE_TYPE and DATABASE_NAME changed in ./.env.
    fs.writeFileSync(path.join(target, '.env'), 'DATABASE_TYPE=sqlite\nDATABASE_NAME=./data/openwa.sqlite\n');

    const run = spawnSync('bash', [path.join(repoRoot, 'scripts/restore.sh'), archive], {
      cwd: target,
      env: { PATH: process.env.PATH ?? '', DATABASE_TYPE: 'postgres', DATABASE_NAME: 'openwa' },
      encoding: 'utf8',
    });

    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).toContain('the environment outranks');
  });

  it('is described in the hazard row as changing the setting where it is set, the environment included', () => {
    const action = hazardRowAction();
    expect(action).toMatch(/environment/i);
    expect(action).toContain('`./.env`');
  });
});
