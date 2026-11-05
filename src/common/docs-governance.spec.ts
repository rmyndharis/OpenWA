import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import * as ts from 'typescript';

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

/** The expression without the parentheses around it. */
const bare = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ? bare(expression.expression) : expression;

/**
 * The classes a source file decorates with Nest's `@Global()`, read from the syntax tree so that how the decorator is
 * spelled does not matter: parentheses, a comment inside it, an aliased, namespace or `import =` binding of `Global`
 * (also read by a quoted member name), decorators in either order or on one line, an unexported class. `unresolved`
 * counts what the reader cannot classify: a decorator named `...Global` that does not trace to an import from
 * `@nestjs/common`, and a `Global` imported from any other module (a look-alike, or a re-export of Nest's under any
 * local name). The caller must treat any as a gap. Not followed: a re-export that renames `Global` itself, and a local
 * declaration that shadows the import.
 */
function globalModulesOf(text: string): { modules: string[]; unresolved: number } {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const decorators = new Set<string>();
  const namespaces = new Set<string>();
  let unresolved = 0;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const fromNest = statement.moduleSpecifier.text === '@nestjs/common';
      const bindings = statement.importClause?.namedBindings;
      if (fromNest && bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text !== 'Global') continue;
          if (fromNest) decorators.add(element.name.text);
          else unresolved++;
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      const target = statement.moduleReference.expression;
      if (ts.isStringLiteral(target) && target.text === '@nestjs/common') namespaces.add(statement.name.text);
    }
  }
  const modules: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node) && ts.canHaveDecorators(node)) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        const expression = bare(decorator.expression);
        const callee = bare(ts.isCallExpression(expression) ? expression.expression : expression);
        // The name it is called by and, for a member (`nest.Global`, `nest['Global']`), what it is read from.
        const [name, owner] = ts.isIdentifier(callee)
          ? [callee.text, undefined]
          : ts.isPropertyAccessExpression(callee)
            ? [callee.name.text, callee.expression]
            : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
              ? [callee.argumentExpression.text, callee.expression]
              : [undefined, undefined];
        if (name === undefined) continue;
        const resolved = owner
          ? ts.isIdentifier(owner) && namespaces.has(owner.text) && name === 'Global'
          : decorators.has(name);
        if (resolved) modules.push(node.name?.text ?? '(anonymous)');
        else if (/Global$/.test(name)) unresolved++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { modules, unresolved };
}

/**
 * The global modules of a set of sources by class name and path, with what the comparison with docs/08 cannot rest
 * on: the paths holding a decorator the reader could not classify, and the class names declared global more than once
 * (the table is keyed by name, so a second declaration would disappear into the first).
 */
function declaredGlobals(files: Array<[path: string, text: string]>): {
  declared: Map<string, string>;
  unresolved: string[];
  ambiguous: string[];
} {
  const declared = new Map<string, string>();
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  for (const [path, text] of files) {
    const found = globalModulesOf(text);
    for (const name of found.modules) {
      if (declared.has(name)) ambiguous.push(`${name} in ${declared.get(name)} and ${path}`);
      declared.set(name, path);
    }
    if (found.unresolved > 0) unresolved.push(path);
  }
  return { declared, unresolved, ambiguous };
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
    // The table cell also says "live media store", so pin the README sentence carrying the warning.
    expect(read('README.md')).toMatch(
      /backup\.sh` archives only the local media directory, so an S3 bucket needs a backup/,
    );
  });

  // The export writes one archive entry per file, so Step 1's count meets the entry cap at import.
  it('has the storage migration check both import caps before the backend switch', () => {
    const guide = read('docs/14-migration-guide.md');
    const caps = between(guide, 'Check the import caps before the switch.', '\n\n').replace(/\s+/g, ' ');
    expect(caps).toContain('`STORAGE_IMPORT_MAX_ENTRIES` files (default `100000`)');
    expect(caps).toContain("Step 1's `sizeBytes` or `count`");
    // The import buffers each file whole, so a raised per-entry cap must fit the container's memory.
    expect(caps).toContain('`OPENWA_MEM_LIMIT` (default `2g`)');
    const step1 = between(guide, '# Step 1: Check current storage file count', '# Step 2').replace(/\s+/g, ' ');
    expect(step1).toContain('sizeBytes with STORAGE_IMPORT_MAX_TOTAL_BYTES');
    expect(step1).toContain('count with STORAGE_IMPORT_MAX_ENTRIES');
    // Step 1 cannot show the largest file, so the export warning is the only early per-file signal.
    const step2 = between(guide, '# Step 2: Export all files as tar.gz', '# Step 3').replace(/\s+/g, ' ');
    expect(step2).toContain('docker compose logs openwa-api');
    expect(step2).toContain('STORAGE_IMPORT_MAX_BYTES');
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

  // Chromium has no SOCKS authentication, so on whatsapp-web.js the credentials of a socks4:// or socks5:// proxy URL are
  // never sent. The proxy URL is chosen from the API reference for either engine, so the limit has to be stated there.
  it('tells a whatsapp-web.js operator that a SOCKS proxy URL cannot log in', () => {
    const states = (text: string): boolean =>
      text
        .replace(/\s+/g, ' ')
        .split(/(?<=\.)\s+/)
        .some(
          sentence =>
            /whatsapp-web\.js/.test(sentence) && /SOCKS/.test(sentence) && /user name and password/.test(sentence),
        );
    const api = read('docs/06-api-specification.md');
    expect(states(between(api, 'per-session egress proxy.**', '**Response** `201`'))).toBe(true);
    const rows = api.split('\n').filter(line => line.startsWith('| `proxyUrl`'));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatch(/whatsapp-web\.js[^|]*SOCKS|SOCKS[^|]*whatsapp-web\.js/);
    const faq = read('docs/12-troubleshooting-faq.md');
    expect(states(between(faq, 'Proxy egress (if WhatsApp is blocked', '### Issue:'))).toBe(true);
  });

  // The bootstrap key file outlives a demotion or a scope change, and the Helm chart's StatefulSet
  // leaves no pod to exec into once it is scaled to 0 for the database write.
  it('gives the admin key recovery its Helm commands and the bootstrap key caveat', () => {
    const security = read('docs/04-security-design.md');
    const recovery = between(security, '### Recovering a lost admin key', '\n## ');
    expect(read('charts/openwa/templates/NOTES.txt')).toContain('default "/app/data/.api-key"');
    expect(recovery).toContain('`kubectl exec openwa-0 -- cat /app/data/.api-key`');
    expect(recovery).toMatch(/demoted from `admin`[\s\S]+go on to step 2 or 3/);
    expect(recovery).toMatch(/given any `allowedSessions` or `allowedChats`, or given `allowedIps` that exclude/);
    expect(recovery).toMatch(/`allowedIps` \(when set\) admits/);
    expect(recovery).toContain('`kubectl exec openwa-0 -- node -e "$GEN"`');
    expect(recovery).toContain('`kubectl exec openwa-restore --`');
    const restore = between(read('docs/11-operational-runbooks.md'), '### Runbook: Restore from Backup', '\n### ');
    expect(restore).toContain('name: openwa-restore');
    expect(restore).toContain('claimName: data-openwa-0');
    const pepper = between(security, '**Setting or changing `API_KEY_PEPPER`', '\n\n');
    expect(pepper).toContain('`kubectl exec openwa-restore -- sqlite3 /app/data/main.sqlite "DELETE FROM api_keys"`');
    const faq = between(read('docs/12-troubleshooting-faq.md'), '**Q: I lost the admin API key.', '\n\n### ');
    expect(faq).not.toMatch(/first started with/);
    expect(faq).toMatch(/last seeded, which still works while that key is an active, unscoped ADMIN key/);
  });

  // The gateway writes only 'inbound' dead letters, but the data import copies `direction` as stored.
  // Plugin manifests load in the global PluginsModule's onModuleInit, before the startup prune runs, so
  // a prune-written dead letter derives its conversation id from the current manifest route.
  it('describes integration dead letters as written inbound and restored as stored', () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ');
    const importer = between(read('src/modules/infra/table-importers.ts'), "key: 'integrationDeliveryFailures'", '}),');
    expect(importer).toMatch(/map: \(df: IntegrationDeliveryFailureRow\) => \[\s*df\.id,\s*df\.direction,/);
    expect(read('src/modules/integration/redrive.service.ts')).toMatch(/direction: 'inbound'/);
    expect(read('src/core/plugins/plugins.module.ts')).toMatch(/@Global\(\)/);
    expect(read('src/core/plugins/plugin-loader.service.ts')).toMatch(
      /onModuleInit\(\): void \{\s*this\.scanner\.scanAtBoot\(\)/,
    );
    const table = '- **`integration_delivery_failures`**';
    const fabric = flat(read('docs/25-integration-fabric.md'));
    for (const entry of [
      between(flat(read('docs/05-database-design.md')), table, ' - **'),
      between(fabric, table, ' ## '),
    ]) {
      expect(entry).not.toMatch(/`direction` is (always )?`inbound`/);
      expect(entry).toContain("A data import restores each row's `direction` as stored");
    }
    expect(fabric).not.toMatch(/before plugins load/);
    expect(fabric).toContain(
      "A dead-letter row the prune writes takes its conversation id from the plugin's current manifest route, as the live path does",
    );
    expect(fabric).toContain('or whose pointer does not resolve in that delivery carries none');
  });

  // docs/08 8.3 freezes the set of @Global() modules and says why each one is global. The table is what a contributor
  // reads before adding one, so it has to name exactly the modules the source declares, with their paths.
  it('lists in docs/08 exactly the modules the source declares global', () => {
    const sources = (readdirSync(join(root, 'src'), { recursive: true }) as string[])
      .filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file): [string, string] => {
        const path = `src/${file.split('\\').join('/')}`;
        return [path, read(path)];
      });
    const { declared, unresolved, ambiguous } = declaredGlobals(sources);
    const documented = new Map<string, string>();
    for (const line of between(read('docs/08-development-guidelines.md'), '### Global modules', '\n## ').split('\n')) {
      const cells = line.split('|').map(cell => cell.trim());
      const name = cells[1]?.match(/^`(\w+)`$/)?.[1];
      const path = cells[2]?.match(/^`([^`]+)`$/)?.[1];
      if (name && path) documented.set(name, path);
    }
    // Both readers must find a long-standing member, or the comparison below proves nothing.
    expect(declared.get('AuthModule')).toBe('src/modules/auth/auth.module.ts');
    expect(documented.get('AuthModule')).toBe('src/modules/auth/auth.module.ts');
    // A Global that does not come from @nestjs/common is one the reader cannot classify, and a class name declared
    // global twice cannot be told apart in the table; naming the files makes the gap visible instead of letting a
    // global module go unlisted.
    expect({ unresolved, ambiguous }).toEqual({ unresolved: [], ambiguous: [] });
    expect(Object.fromEntries([...documented].sort())).toEqual(Object.fromEntries([...declared].sort()));
  });

  describe('globalModulesOf', () => {
    const nest = "import { Global, Module } from '@nestjs/common';\n";

    it.each([
      ['directly above @Module', `${nest}@Global()\n@Module({})\nexport class A {}`],
      ['with a comment between the decorators', `${nest}@Global()\n// shared\n@Module({})\nexport class A {}`],
      ['with the decorators reversed', `${nest}@Module({})\n@Global()\nexport class A {}`],
      ['with both decorators on one line', `${nest}@Global() @Module({}) export class A {}`],
      ['on a class that is not exported', `${nest}@Global()\n@Module({})\nclass A {}`],
      [
        'with a comment inside the decorator',
        `${nest}@Global /* Shared dependency. */()\n@Module({})\nexport class A {}`,
      ],
      [
        'imported under another name',
        "import { Global as NestGlobal } from '@nestjs/common';\n@NestGlobal()\nexport class A {}",
      ],
      ['imported as a namespace', "import * as nest from '@nestjs/common';\n@nest.Global()\nexport class A {}"],
      ['imported with require', "import nest = require('@nestjs/common');\n@nest.Global()\nexport class A {}"],
      ['wrapped in parentheses', `${nest}@(Global)()\n@Module({})\nexport class A {}`],
      [
        'called through a quoted member inside parentheses',
        "import * as nest from '@nestjs/common';\n@(nest['Global']())\nexport class A {}",
      ],
    ])('reads a global module %s', (_shape, text) => {
      expect(globalModulesOf(text)).toEqual({ modules: ['A'], unresolved: 0 });
    });

    it('reads every global class of a file and none that only mention the decorator', () => {
      const text = `${nest}// @Global()\nconst note = \`\n@Global()\n@Module({})\nexport class Quoted {}\n\`;\n/**\n * @Global()\n */\n@Global()\n@Module({})\nexport class A {}\n@Module({})\nexport class Plain {}\n@Global()\nexport class B {}`;
      expect(globalModulesOf(text)).toEqual({ modules: ['A', 'B'], unresolved: 0 });
    });

    it('reads each of two global classes that share a name', () => {
      const text = `${nest}@Global()\nexport class A {}\nexport function other() {\n  @Global()\n  class A {}\n  return A;\n}`;
      expect(globalModulesOf(text)).toEqual({ modules: ['A', 'A'], unresolved: 0 });
    });

    it('reports a Global imported from another module under any local name', () => {
      expect(globalModulesOf("import { Global as Shared } from './barrel';\n@Shared()\nexport class A {}")).toEqual({
        modules: [],
        unresolved: 1,
      });
    });

    // The import and the decorator are each reported.
    it('reports a Global that does not come from @nestjs/common instead of passing it unseen', () => {
      expect(globalModulesOf("import { Global } from './nest-reexports';\n@Global()\nexport class A {}")).toEqual({
        modules: [],
        unresolved: 2,
      });
    });
  });

  describe('declaredGlobals', () => {
    const nest = "import { Global } from '@nestjs/common';\n";

    it('names each file that holds a Global it cannot classify', () => {
      const result = declaredGlobals([
        ['src/a.module.ts', `${nest}@Global()\nexport class A {}`],
        ['src/b.module.ts', "import { Global as Shared } from './barrel';\n@Shared()\nexport class B {}"],
      ]);

      expect([...result.declared]).toEqual([['A', 'src/a.module.ts']]);
      expect(result.unresolved).toEqual(['src/b.module.ts']);
      expect(result.ambiguous).toEqual([]);
    });

    it('names a class declared global twice, in two files or in one', () => {
      const nested = `${nest}@Global()\nexport class C {}\nexport function other() {\n  @Global()\n  class C {}\n  return C;\n}`;
      const result = declaredGlobals([
        ['src/a.module.ts', `${nest}@Global()\nexport class A {}`],
        ['src/b.module.ts', `${nest}@Global()\nexport class A {}`],
        ['src/c.module.ts', nested],
      ]);

      expect(result.ambiguous).toEqual([
        'A in src/a.module.ts and src/b.module.ts',
        'C in src/c.module.ts and src/c.module.ts',
      ]);
    });
  });

  it('keeps the README non-affiliation disclaimer', () => {
    const section = between(read('README.md'), '## Disclaimer', '\n## ');
    expect(section).toMatch(/not affiliated/);
    expect(section).toMatch(/WhatsApp LLC/);
  });
});
