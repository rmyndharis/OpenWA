import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSecretFile } from './secret-file';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, chmodSync: jest.fn(actual.chmodSync) };
});

/**
 * A chmod failure while writing a secret file is reported in the configured log format: in production
 * that is JSON, so a log pipeline can parse and filter it like every other line.
 */
describe('writeSecretFile chmod failure report', () => {
  const envBackup = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-secretfile-'));
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_FORMAT;
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
    jest.mocked(fs.chmodSync).mockImplementation(jest.requireActual<typeof import('fs')>('fs').chmodSync);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the warning as a JSON log line in production', () => {
    const file = path.join(dir, '.env.generated');
    fs.writeFileSync(file, 'old');
    jest.mocked(fs.chmodSync).mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    const lines: string[] = [];
    for (const channel of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, channel).mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
    }

    writeSecretFile(file, 'new');

    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(lines.length).toBeGreaterThan(0);
    const entries = lines.map(line => JSON.parse(line) as { level: string; message: string });
    expect(entries.map(entry => entry.level)).toEqual(['warn', 'warn']);
    expect(entries[0].message).toContain('pre-write chmod 0o600 failed');
    expect(entries[1].message).toContain('post-write chmod 0o600 failed');
  });
});
