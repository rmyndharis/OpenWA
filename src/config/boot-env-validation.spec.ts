import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Boots the real entry point with an invalid environment on the built-in PostgreSQL path, the one
 * that does Docker I/O before NestFactory.create. The config must be rejected once, before any of
 * that runs, instead of starting the container and then failing inside the module graph.
 */
describe('main.ts validates the environment before any boot side effect', () => {
  const REPO = join(__dirname, '..', '..');
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'openwa-boot-env-'));
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('exits 1 with one fatal line and never reaches DockerService', () => {
    const result = spawnSync(
      join(REPO, 'node_modules', '.bin', 'ts-node-transpile-only'),
      ['--project', join(REPO, 'tsconfig.json'), join(REPO, 'src', 'main.ts')],
      {
        cwd,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LOG_LEVEL: 'bogus',
          DATABASE_TYPE: 'postgres',
          POSTGRES_BUILTIN: 'true',
          DATABASE_HOST: 'db',
          DATABASE_USERNAME: 'u',
          DATABASE_PASSWORD: 'p',
          DOCKER_HOST: 'tcp://127.0.0.1:1',
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('Fatal error during bootstrap');
    expect(output).toContain('LOG_LEVEL must be one of');
    expect(output).not.toContain('Unhandled promise rejection');
    expect(output).not.toContain('DockerService');
    expect(output.match(/LOG_LEVEL must be one of/g)).toHaveLength(1);
  }, 90_000);
});
