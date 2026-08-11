#!/usr/bin/env node
/**
 * Chart behaviour guard.
 *
 * CI already runs `helm lint`, `helm template` and `kubeconform` against the chart. All three answer
 * the same question — does this render into schema-valid YAML — and none of them can see a chart that
 * renders perfectly and behaves wrongly in a cluster: a ServiceMonitor selector that matches two
 * Services, a probe budget that boot cannot meet, or a configuration change that reaches no running
 * container. Each of those shipped, and each passed every existing check.
 *
 * So this guard renders the chart with real helm and asserts against the rendered objects rather than
 * against the template source. Reading the objects is what makes the assertions possible: "does the
 * pod template change" is not a property of any one template file, it is a property of the render.
 *
 * `render-is-deterministic` is a control, not a feature check. `config-change-rolls-pods` can be
 * satisfied by a checksum over anything that varies per render — a timestamp, a random value — which
 * would roll every pod on every `helm upgrade`, a worse defect than the one being prevented, and one
 * that reads as a pass. The control fails on exactly that. Keep the two together; the feature check
 * alone is not evidence.
 *
 * Run locally: `npm run check:chart`. Runs in CI (Helm chart and workflows job). Needs Docker.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pinned in step with the `helm lint` / `helm template` steps of .github/workflows/ci.yml. A version
// skew here renders with an older helm, which fails loudly rather than passing something wrong.
const HELM_IMAGE = 'alpine/helm:4.2.3';
const CHARTS = fileURLToPath(new URL('../charts', import.meta.url));

const render = (...setArgs) =>
  execFileSync('docker', ['run', '--rm', '-v', `${CHARTS}:/charts:ro`, HELM_IMAGE, 'template', 'ci', '/charts/openwa', ...setArgs], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

const documents = out => out.split('\n---\n');
const kindOf = doc => /^kind:\s*(\S+)/m.exec(doc)?.[1];
const nameOf = doc => /^\s{2}name:\s*(\S+)/m.exec(doc)?.[1];
const byKind = (out, kind) => documents(out).filter(d => kindOf(d) === kind);

/**
 * The flat scalar entries of the mapping at `path`, e.g. `mapAt(doc, ['spec', 'selector', 'matchLabels'])`.
 *
 * Indentation-aware rather than a regex per call site: the same key sits at a different depth in each
 * object, and a regex written for one depth does not fail on another — it silently matches nothing and
 * yields an empty mapping, which an `every()` over its entries then reports as "matches everything".
 * Nested blocks below `path` are flattened in; every caller here reads scalars it names explicitly.
 */
function mapAt(doc, path) {
  const lines = doc.split('\n');
  let depth = -1;
  let i = 0;
  for (const key of path) {
    const re = new RegExp(`^(\\s*)${key}:\\s*$`);
    let found = -1;
    for (; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (m && m[1].length > depth) {
        found = m[1].length;
        break;
      }
    }
    if (found < 0) return null;
    depth = found;
    i++;
  }
  const out = {};
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (lines[i].length - lines[i].trimStart().length <= depth) break;
    const m = /^([^:]+):\s*(.*)$/.exec(trimmed);
    if (m) out[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** The StatefulSet's pod template — the bytes the kubelet compares to decide whether to roll pods. */
function podTemplate(out) {
  const doc = byKind(out, 'StatefulSet')[0] ?? '';
  const at = doc.indexOf('\n  template:');
  return at < 0 ? '' : doc.slice(at);
}

/**
 * When the kubelet gives up on a probe. The first attempt fires at `initialDelaySeconds` and the
 * verdict lands on the Nth consecutive failure, so the budget is initialDelay + period × (threshold −
 * 1) — one period shorter than the obvious reading.
 */
const probeBudget = probe =>
  Number(probe?.initialDelaySeconds ?? 0) + Number(probe?.periodSeconds ?? 10) * (Number(probe?.failureThreshold ?? 3) - 1);

const results = [];
const check = (id, ok, detail) => results.push({ id, ok, detail });

// A configuration-only upgrade must perturb the pod template. Both the ConfigMap and the Secret reach
// the container through envFrom, which is read once at container creation — so without a pod-template
// change the rollout is a no-op and the running container keeps the values it started with.
{
  const sts = nameOf(byKind(render(), 'StatefulSet')[0] ?? '') ?? 'StatefulSet';
  const envRolls = podTemplate(render('--set', 'env.LOG_LEVEL=info')) !== podTemplate(render('--set', 'env.LOG_LEVEL=debug'));
  const secretRolls = podTemplate(render('--set', 'secretEnv.API_KEY=aaa')) !== podTemplate(render('--set', 'secretEnv.API_KEY=bbb'));
  const stale = [!envRolls && 'ConfigMap (env)', !secretRolls && 'Secret (secretEnv)'].filter(Boolean);
  check(
    'config-change-rolls-pods',
    envRolls && secretRolls,
    stale.length ? `${sts}: pod template unchanged by ${stale.join(' and ')} — an upgrade would roll nothing` : 'env and secretEnv each move the pod template',
  );
}

// CONTROL. Two identical renders must produce an identical pod template. A checksum over anything
// that varies per render satisfies the assertion above while restarting every pod on every upgrade.
{
  const a = podTemplate(render());
  const b = podTemplate(render());
  const at = [...a].findIndex((ch, i) => ch !== b[i]);
  check(
    'render-is-deterministic',
    a === b,
    a === b
      ? 'two identical renders agree, so the checksums above are over the configuration and not over the render'
      : `pod template differs between two identical renders at offset ${at}: ${JSON.stringify(a.slice(at, at + 60))} vs ${JSON.stringify(b.slice(at, at + 60))}`,
  );
}

// Boot is long and varies with the number of sessions to restore. That belongs to a startupProbe: it
// suspends the liveness probe until it succeeds, so the boot window and the running-health window can
// be set independently. Without one, the liveness budget alone decides how long boot may take.
{
  const sts = byKind(render(), 'StatefulSet')[0] ?? '';
  const startup = mapAt(sts, ['startupProbe']);
  const liveness = mapAt(sts, ['livenessProbe']);
  const startupBudget = probeBudget(startup);
  const livenessBudget = probeBudget(liveness);
  check(
    'boot-budget-exceeds-liveness-budget',
    Boolean(startup) && startupBudget > livenessBudget,
    !startup
      ? `${nameOf(sts) ?? 'StatefulSet'}: no startupProbe, so boot must finish inside the ${livenessBudget}s liveness budget or the kubelet restarts the pod mid-boot`
      : `startupProbe allows ${startupBudget}s, liveness allows ${livenessBudget}s`,
  );
}

// One scrape target per pod per endpoint. Prometheus Operator yields a target for every address of
// every Service matching the selector and de-duplicates nothing by pod, so a selector matching N
// Services produces N series sets separated only by the `service` label.
{
  const out = render('--set', 'serviceMonitor.enabled=true');
  const monitor = byKind(out, 'ServiceMonitor')[0] ?? '';
  const selector = mapAt(monitor, ['spec', 'selector', 'matchLabels']) ?? {};
  const port = /^\s*-\s*port:\s*(\S+)/m.exec(monitor)?.[1];
  const matched = byKind(out, 'Service')
    .filter(doc => {
      const labels = mapAt(doc, ['metadata', 'labels']) ?? {};
      return Object.entries(selector).every(([k, v]) => labels[k] === v);
    })
    .filter(doc => new RegExp(`^\\s*-?\\s*name:\\s*${port}\\b`, 'm').test(doc))
    .map(doc => nameOf(doc) ?? '(unnamed)');
  check(
    'one-scrape-target-per-pod',
    Object.keys(selector).length > 0 && matched.length === 1,
    Object.keys(selector).length === 0
      ? `${nameOf(monitor) ?? 'ServiceMonitor'}: empty selector — it would match every Service in the namespace`
      : `${matched.length} Service(s) match the selector on port '${port}': ${matched.join(', ') || '(none)'}`,
  );
}

const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.error('\n✖ Chart behaviour check failed:');
  for (const r of failed) console.error(`  - ${r.id}: ${r.detail}`);
  console.error('\nThese assert against the rendered objects, so `helm lint` and `kubeconform` cannot catch them.');
  console.error('Re-run with `npm run check:chart` after fixing the chart.\n');
  process.exit(1);
}
for (const r of results) console.log(`  ✓ ${r.id} — ${r.detail}`);
console.log(`✓ Chart behaviour check OK (${results.length} assertions against the rendered chart).`);
