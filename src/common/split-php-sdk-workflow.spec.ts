import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

type Job = { if?: string; steps?: { name?: string; run?: string }[] };
type Workflow = { jobs: Record<string, Job> };

/**
 * The job force-pushes the SDK tree to the mirror's main, which is what Packagist reads as dev-main.
 * A manual run on another ref, or a re-run of an older push after a newer SDK change was mirrored,
 * must not replace it.
 */
describe('split-php-sdk.yml', () => {
  const workflow = load(
    readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'split-php-sdk.yml'), 'utf8'),
  ) as Workflow;

  it.each(['test', 'split'])('runs the %s job only on main', job => {
    expect(workflow.jobs[job].if).toBe("github.ref == 'refs/heads/main'");
  });

  it('pushes only after the checked-out SDK tree is compared with the one on main', () => {
    const run = workflow.jobs.split.steps?.find(step => step.name?.startsWith('Split and force-push'))?.run ?? '';
    const lines = run.split('\n').map(line => line.trim());
    const fetch = lines.findIndex(line => line.startsWith('git fetch') && line.endsWith('refs/heads/main'));
    const compare = lines.findIndex(line => line.includes('HEAD:sdk/php') && line.includes('FETCH_HEAD:sdk/php'));
    const push = lines.findIndex(line => line.includes('push --force'));

    expect(fetch).toBeGreaterThan(-1);
    expect(compare).toBeGreaterThan(fetch);
    expect(push).toBeGreaterThan(compare);
  });
});
