import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateEnv } from './env.validation';

/**
 * LOG_FORMAT is read after trim and lower-casing, and anything other than json or pretty falls back to
 * the NODE_ENV default. A value the logger cannot use is named at boot together with the format that
 * is written instead; the boot itself goes on, since the gateway still logs.
 */
describe('LOG_FORMAT the logger cannot use', () => {
  let envBackup: NodeJS.ProcessEnv;
  const tempDirs: string[] = [];
  let written: string[];

  const bootWith = (dotenv: string): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-logformat-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, '.env'), dotenv);
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=sqlite\n');
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./load-env');
  };

  const warnings = (): string[] => written.filter(line => line.includes('LOG_FORMAT='));

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const key of ['NODE_ENV', 'LOG_LEVEL', 'LOG_FORMAT', 'NO_COLOR', 'FORCE_COLOR']) delete process.env[key];
    process.env.NO_COLOR = '1';
    written = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) delete process.env[key];
    }
    Object.assign(process.env, envBackup);
    jest.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names a misspelt value and the JSON written instead in production', () => {
    bootWith('NODE_ENV=production\nLOG_FORMAT=jsn\n');

    expect(warnings()).toHaveLength(1);
    const entry = JSON.parse(warnings()[0]) as { level: string; message: string };
    expect(entry.level).toBe('warn');
    expect(entry.message).toBe('LOG_FORMAT="jsn" is not json or pretty; writing json, the NODE_ENV default');
  });

  it('names an unknown value and the pretty text written instead outside production', () => {
    bootWith('LOG_FORMAT=text\n');

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('WARN');
    expect(warnings()[0]).toContain('LOG_FORMAT="text" is not json or pretty; writing pretty, the NODE_ENV default');
  });

  it.each(['json', 'PRETTY', ' pretty ', ''])('stays silent for LOG_FORMAT=%j, which the logger honours', value => {
    bootWith(`LOG_FORMAT=${value}\n`);

    expect(warnings()).toEqual([]);
  });

  it('reports rather than refuses: boot validation accepts the value', () => {
    expect(() => validateEnv({ LOG_FORMAT: 'jsn' })).not.toThrow();
  });
});
