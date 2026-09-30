import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The global rate limiter has an hourly tier (`RATE_LIMIT_LONG_TTL`, one hour by default), so its
 * 429 can last up to an hour. Every SDK README states that; one that promises the 429 clears
 * within seconds sends its readers into a retry loop against an hour-long window.
 */
describe('SDK READMEs: global rate limiter 429 duration', () => {
  const repoRoot = join(__dirname, '..', '..');
  const readmes = ['javascript', 'python', 'php', 'go', 'java'].map(sdk => `sdk/${sdk}/README.md`);

  it.each(readmes)('%s names the hourly tier and no seconds-only promise', path => {
    const text = readFileSync(join(repoRoot, path), 'utf8').replace(/\s+/g, ' ');
    expect(text).toContain('up to an hour for the hourly tier by default');
    expect(text).not.toMatch(/clears within seconds/);
  });
});
