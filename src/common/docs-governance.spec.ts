import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * The contributor docs restate the CI trigger branches and the repository label set by hand. Both
 * drifted: the docs and the workflows named a `develop` branch that never existed, and the label
 * table missed labels Dependabot applies to every dependency PR. These pin the hand-written copies
 * to the files that actually decide the behaviour.
 */

const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

/**
 * Patch releases from `0.24.0` on whose CHANGELOG section carries a breaking entry or an Upgrade
 * notes heading. docs/15 section 15.2 reserves both for a MINOR; earlier patches that broke the rule
 * are listed there and stay out of scope. A breaking entry is matched in every spelling the file has
 * used: `**Breaking`, `**BREAKING` and an unbolded warning-sign `Breaking:`.
 */
function patchesCarryingBreakingChanges(changelog: string): string[] {
  return changelog.split(/^(?=## \[)/m).flatMap(block => {
    const version = /^## \[(\d+)\.(\d+)\.(\d+)\]/.exec(block);
    if (!version) return [];
    const [major, minor, patch] = version.slice(1).map(Number);
    const enforced = major > 0 || minor >= 24;
    return enforced && patch > 0 && /^### Upgrade notes|\*\*breaking|\u26a0\ufe0f?\s*\**\s*breaking/im.test(block)
      ? [version.slice(1).join('.')]
      : [];
  });
}

type Trigger = { branches?: string[] };
type Workflow = { on?: { push?: Trigger; pull_request?: Trigger } };

describe('governance docs match the repository', () => {
  it.each(['ci.yml', 'sdk-ci.yml'])('%s runs on main only', file => {
    const wf = yaml.load(read('.github', 'workflows', file)) as Workflow;
    expect(wf.on?.push?.branches).toEqual(['main']);
    expect(wf.on?.pull_request?.branches).toEqual(['main']);
  });

  it('keeps the recommended security workflow template on main only', () => {
    const template = between(read('docs/04-security-design.md'), '# .github/workflows/security.yml', '\n```');
    expect((yaml.load(template) as Workflow).on?.push?.branches).toEqual(['main']);
  });

  it.each([
    ['docs/08-development-guidelines.md', '## 8.4', '## 8.5'],
    ['docs/10-devops-infrastructure.md', '## 10.3', '## 10.4'],
    ['docs/20-community-guidelines.md', '## 20.2', '## 20.3'],
  ])('%s names main and no develop branch', (file, from, to) => {
    const section = between(read(file), from, to);
    expect(section).toContain('`main`');
    expect(section).not.toMatch(/\bdevelop\b/);
  });

  it('documents every label the repository applies automatically', () => {
    const dependabot = yaml.load(read('.github', 'dependabot.yml')) as { updates: Array<{ labels?: string[] }> };
    const templateDir = join(root, '.github', 'ISSUE_TEMPLATE');
    const templateLabels = readdirSync(templateDir)
      .filter(name => name.endsWith('.yml'))
      .flatMap(
        name => (yaml.load(readFileSync(join(templateDir, name), 'utf8')) as { labels?: string[] }).labels ?? [],
      );
    const applied = [...new Set([...dependabot.updates.flatMap(u => u.labels ?? []), ...templateLabels])];

    const documented = new Set<string>();
    for (const line of between(read('docs/20-community-guidelines.md'), '### Issue Labels', '## 20.4').split('\n')) {
      const cells = line.split('|').map(cell => cell.trim());
      const name = cells[1]?.match(/^`([^`]+)`$/);
      if (name) documented.add(name[1]);
    }

    // Guard both parsers: either one matching nothing would make the final check pass vacuously.
    expect(applied.length).toBeGreaterThanOrEqual(6);
    expect(documented.size).toBeGreaterThanOrEqual(20);
    expect(applied.filter(label => !documented.has(label))).toEqual([]);
  });

  it('keeps breaking entries and Upgrade notes out of patch releases', () => {
    expect(patchesCarryingBreakingChanges(read('CHANGELOG.md'))).toEqual([]);
  });

  // The operator-facing upgrade matrix restates the section 15.2 rule, so it has to name the same
  // triggers for a MINOR and admit the earlier patches that did not hold to it.
  it('states the docs/15 version rule in the docs/14 upgrade matrix', () => {
    expect(between(read('docs/15-project-roadmap.md'), '### Pre-1.0 policy', '## 15.3')).toMatch(
      /Upgrade notes \(behavior changes\)/,
    );
    const matrix = between(read('docs/14-migration-guide.md'), '### Upgrade Matrix', '\n| From');
    expect(matrix).toMatch(/breaking change, or anything the CHANGELOG files under \*\*Upgrade notes/);
    expect(matrix).toMatch(/`0\.24\.0`/);
  });

  it('flags a patch release that carries either', () => {
    const sample = [
      '## [Unreleased]\n### Upgrade notes (behavior changes)\n- pending',
      '## [0.24.4] - 2026-10-04\n### Changed\n- **BREAKING \u2014 single-port dashboard:** x',
      '## [0.24.3] - 2026-10-03\n### Removed\n- \u26a0\ufe0f Breaking: bundled extensions removed',
      '## [0.24.2] - 2026-10-02\n### Fixed\n- \u26a0\ufe0f **Breaking (API).** a route answers 400',
      '## [0.24.1] - 2026-10-01\n### Upgrade notes (behavior changes)\n- a default changed',
      '## [0.24.0] - 2026-09-30\n### Upgrade notes (behavior changes)\n- a MINOR may',
      '## [0.23.7] - 2026-09-25\n### Upgrade notes (behavior changes)\n- before the rule',
    ].join('\n');
    expect(patchesCarryingBreakingChanges(sample)).toEqual(['0.24.4', '0.24.3', '0.24.2', '0.24.1']);
  });

  it('points the circular-dependency advice at the comment that explains the delegation', () => {
    const section = between(read('docs/08-development-guidelines.md'), '#### Circular Dependency', '\n#### ');
    const cited = /`(src\/[^`]+\.ts)`/.exec(section)?.[1];
    expect(cited).toBeDefined();
    expect(read(cited!)).toMatch(/delegates .*one-directionally/);
  });

  // The override keeps the service's `build:` section, so `--build` would tag a source build with the
  // published image name. The README, the release guide and the migration guide give one upgrade command.
  it('gives the published-image override one upgrade command in the README, docs/14 and docs/15', () => {
    const command = 'docker compose pull openwa-api && docker compose up -d --no-build';
    const readme = between(read('README.md'), 'To run a published image', '\n## ');
    expect(readme).toContain(command);
    expect(readme).not.toMatch(/still builds from source/);
    // Compose pulls a missing image first; only a failed pull falls back to a source build.
    expect(readme).not.toMatch(/missing image would be built/);
    expect(readme).toMatch(/if the pull fails/);
    expect(between(read('docs/15-project-roadmap.md'), 'Upgrading a Compose deployment', '\n## ')).toContain(command);
    const migration = read('docs/14-migration-guide.md');
    expect(between(migration, '# 3. Move to the new version', '# 4.')).toContain(command);
    expect(between(migration, '# 5. Start the target version', 'echo')).toContain(command);
  });

  // `docker compose run` has no --no-build, so the runbook confirms the pull landed before step 7.
  it('keeps the runbook published-image upgrade from building after a failed pull', () => {
    const note = between(read('docs/11-operational-runbooks.md'), '> If you deploy the published image', '\n\n');
    expect(note).toContain('`docker compose pull openwa-api`');
    expect(note).toContain('`docker image inspect ghcr.io/rmyndharis/openwa:<tag>`');
    expect(note).toContain('`docker compose up -d --no-build`');
  });

  // Compose hands `./.env`'s PLUGINS_DIR to the container, where `./data/plugins` is in the volume,
  // so the backup scripts read it, like the ./data defaults, under OPENWA_DATA_DIR.
  it('tells a host-mount backup that ./data paths in ./.env follow OPENWA_DATA_DIR', () => {
    expect(read('.env.example')).toMatch(/^PLUGINS_DIR=\.\/data\/plugins\b/m);
    expect(read('docker-compose.yml')).toContain('- PLUGINS_DIR=${PLUGINS_DIR:-');
    const note = between(read('docs/11-operational-runbooks.md'), '> The scripts resolve every other path', '\n>\n')
      .replace(/^> ?/gm, '')
      .replace(/\s+/g, ' ');
    expect(note).toContain('A relative `./data/...` path in `./.env` or `.env.generated`');
    expect(note).toContain('`PLUGINS_DIR=./data/plugins`');
    expect(note).toContain('is read under `OPENWA_DATA_DIR`, as are the `./data` database and state defaults');
  });

  // docs/20 section 20.4: the project runs no real-time chat server, and the `openwa` name is shared.
  it('links no chat server the project does not run', () => {
    const docs = readdirSync(join(root, 'docs'))
      .filter(name => name.endsWith('.md'))
      .map(name => `docs/${name}`);
    expect(docs.length).toBeGreaterThanOrEqual(20);
    expect(['README.md', ...docs].filter(file => /discord\.(gg|com\/invite)/i.test(read(file)))).toEqual([]);
  });

  // Most values in the Standard profile are the defaults; only some groups differ.
  it('does not call every commented Standard profile value a non-default', () => {
    const header = between(read('docs/08-development-guidelines.md'), '#### Standard Profile', '# Application');
    expect(header).not.toMatch(/which are not the defaults/);
    expect(header).toMatch(/set the ones that differ from the defaults/);
  });

  // Registries show the package description on its own in search results, away from the README.
  it('keeps the non-affiliation notice in every SDK registry description', () => {
    const descriptions = [
      (JSON.parse(read('sdk/javascript/package.json')) as { description: string }).description,
      (JSON.parse(read('sdk/php/composer.json')) as { description: string }).description,
      /^description = "([^"]+)"/m.exec(read('sdk/python/pyproject.toml'))?.[1],
      /<description>([^<]+)<\/description>/.exec(read('sdk/java/pom.xml'))?.[1],
    ];
    for (const description of descriptions) {
      expect(description).toMatch(
        /^Official .+ SDK for OpenWA, the open-source WhatsApp API Gateway \(not affiliated with WhatsApp or Meta\)$/,
      );
    }
    // Go has no registry manifest: pkg.go.dev shows the package comment's first sentence instead.
    expect(read('sdk/go/client.go')).toMatch(
      /^\/\/ Package openwa is the official Go client for OpenWA, the open-source WhatsApp API Gateway \(not\n\/\/ affiliated with WhatsApp or Meta\)\./,
    );
  });

  // The risk guide counts this published notice as the legal risk's mitigation.
  // The project publishes no terms of service of its own, so no mitigation may rest on one.
  it('counts the README disclaimer, not user terms of service, as a risk mitigation', () => {
    const risks = read('docs/16-risk-management.md');
    expect(risks).not.toMatch(/\[[^\]]*terms of service[^\]]*\]/i);
    expect(risks).toMatch(/\[README disclaimer\]/);
  });

  // A delivery that spent its retries is not retried by its dispatch. Only a shed, shutdown-refused or
  // interrupted event goes back through the outbox sweep, and the operator can replay a terminal row
  // whose payload was kept.
  it('points the webhook runbook and the glossary at the outbound redrive route', () => {
    const route = '/api/webhooks/delivery-failures/redrive';
    const staleClaim = /No retry-failed API|auto-retr|nothing retries|for plugin ingress only/i;
    const openapi = JSON.parse(read('openapi.json')) as { paths: Record<string, { post?: unknown }> };
    expect(openapi.paths[route]?.post).toBeDefined();
    const runbook = between(read('docs/11-operational-runbooks.md'), '### Runbook: Webhook Delivery Failure', '\n### ');
    expect(runbook).toContain(route);
    expect(runbook).toContain('WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS');
    expect(runbook).not.toMatch(staleClaim);
    // The sweep can still replay an attempts > 0 row, so a redrive may race it, but only while it runs.
    expect(runbook).toContain('WEBHOOK_RECONCILE_MAX_ATTEMPTS');
    expect(runbook).toContain('WEBHOOK_RECONCILE_INTERVAL_MS');
    expect(runbook).toMatch(/skipped > 0/);
    const glossary = between(read('docs/21-glossary.md'), '### Dead Letter Queue (DLQ)', '\n### ');
    expect(glossary).toContain(route);
    expect(glossary).toContain('WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS');
    expect(glossary).toContain('WEBHOOK_RECONCILE_INTERVAL_MS');
    expect(glossary).not.toMatch(staleClaim);
  });

  // A direct sweep replay that fails keeps its outbox copy pending, a delivered redrive closes it,
  // and the replay budget counts replays, not sweeps. An attempts-0 row the sweep never replays has
  // no other way back, since redrive takes only terminal rows.
  it('describes the webhook outbox copy after a sweep replay or a redrive', () => {
    const flat = (text: string): string => text.replace(/\n#?\s*/g, ' ').replace(/\s+/g, ' ');
    const doc06 = read('docs/06-api-specification.md');
    const redrive = between(doc06, '#### POST /api/webhooks/delivery-failures/redrive', '\n#### ');
    expect(redrive).toMatch(/Success removes its row and closes any outbox copy/);
    expect(redrive).toMatch(/sweep replay of the same event already under way can still POST/);
    expect(redrive).toMatch(/excluded before applying the limit when it has `attempts: 0`/);
    const crash = between(doc06, '**Crash boundary.**', '\n\n');
    expect(crash).toMatch(/^\*\*Crash boundary\.\*\* For an ordinary dispatch, a successfully written outbox record/);
    expect(crash).toMatch(
      /\(the queue off, or its enqueue failed\) that exhausts its retries stores its terminal failure row but keeps the outbox copy pending/,
    );
    const runbook = flat(between(read('docs/11-operational-runbooks.md'), '# 6. Replay deliveries', '```'));
    expect(runbook).toContain('until WEBHOOK_RECONCILE_MAX_ATTEMPTS replays are spent');
    const glossary = between(read('docs/21-glossary.md'), '### Dead Letter Queue (DLQ)', '\n### ');
    expect(glossary).toMatch(
      /with the sweep off such an event is not replayed, but turning the sweep back on replays it/,
    );
    expect(glossary).toMatch(
      /shed or shutdown-refused one the sweep dropped because its webhook was removed, disabled or unsubscribed, nor/,
    );
    expect(doc06).not.toMatch(/Removed, disabled, unsubscribed, expired and out-of-scope rows are excluded/);
    const outbox = between(read('docs/05-database-design.md'), '- **`webhook_outbox_events`**', '\n');
    expect(outbox).toMatch(/For an ordinary dispatch, delivery success, subscription invalidation/);
    expect(outbox).toMatch(/that fails keeps the copy pending until the replay budget is spent/);
    expect(outbox).toMatch(/a delivered redrive of the event also retires it/);
  });

  // Status media lives only in the storage backend, and backup.sh never copies an S3 bucket.
  it('describes the storage backend as the live media store, not a backup target', () => {
    expect(read('scripts/backup.sh')).toMatch(/the bucket's contents are not archived/);
    for (const file of ['README.md', 'docs/03-system-architecture.md']) {
      expect(read(file)).not.toMatch(/backup\s*\/\s*migration|media backup/i);
      expect(read(file)).toMatch(/live media store/i);
    }
  });

  // The Java transport waits on the whole exchange with the client timeout, so a slow media download
  // can time out where it once finished. Callers size the timeout from these two descriptions.
  it('says the Java SDK timeout also bounds the response body', () => {
    const java = 'sdk/java/src/main/java/com/rmyndharis/openwa';
    expect(read(java, 'http/DefaultHttpTransport.java')).toMatch(/future\.get\(timeoutMs, TimeUnit\.MILLISECONDS\)/);
    const readme = between(read('sdk/java/README.md'), '- **Default per-request timeout**', '\n- **');
    expect(readme.replace(/\s+/g, ' ')).toMatch(/bounds the whole exchange, response body included/);
    expect(read(java, 'ClientConfig.java')).toMatch(
      /Per-request timeout \(default 30s\), covering the whole exchange, response body included, with the default transport/,
    );
  });

  it('keeps the README non-affiliation disclaimer', () => {
    const section = between(read('README.md'), '## Disclaimer', '\n## ');
    expect(section).toMatch(/not affiliated/);
    expect(section).toMatch(/WhatsApp LLC/);
  });
});
