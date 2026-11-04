import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

type Step = { name?: string; run?: string; with?: { body_path?: string } };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

describe('Release note extraction', () => {
  const workflow = load(
    readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8'),
  ) as Workflow;
  const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
  const extract = steps.find(step => step.name === 'Extract release notes from CHANGELOG')!;
  const publish = steps.find(step => step.name === 'Create GitHub Release')!;

  it.each([
    ['normal', '### Fixed\n\n- Preserve message order.'],
    ['heredoc', '```sh\ncat <<EOF\nhello\nEOF\n```'],
    ['repeated delimiter', 'EOF\nEOF\nNOTES=unexpected\nstill notes'],
    ['literal text', '-n\n\\n stays literal\n${HOME} and $(false) are text'],
    ['empty', ''],
  ])('preserves %s notes without interpreting their content', (_name, notes) => {
    const directory = mkdtempSync(join(tmpdir(), 'openwa-release-notes-'));
    try {
      const output = join(directory, 'outputs');
      writeFileSync(output, '');
      writeFileSync(
        join(directory, 'CHANGELOG.md'),
        `# Changelog\n\n## [0.26.0]\n${notes}\n## [0.25.0]\nolder section\n`,
      );
      const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', extract.run!], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
        env: {
          PATH: process.env.PATH,
          VERSION: '0.26.0',
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
        },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(publish.with?.body_path).toBe('${{ runner.temp }}/release-notes.md');
      const body = readFileSync(join(directory, 'release-notes.md'), 'utf8');
      expect(body).toBe(`${notes || 'Release v0.26.0'}\n`);
      expect(readFileSync(output, 'utf8')).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
