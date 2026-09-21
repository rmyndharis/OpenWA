jest.mock('../plugins/plugin-download', () => ({ fetchSafeBuffer: jest.fn() }));

import { fetchSafeBuffer } from '../plugins/plugin-download';
import { __resetUpdateCheckCache, checkForUpdate, isNewerRelease } from './update-check';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: RUNNING } = require('../../../package.json') as { version: string };

const fetchMock = fetchSafeBuffer as jest.MockedFunction<typeof fetchSafeBuffer>;
const release = (tag: unknown) => Buffer.from(JSON.stringify({ tag_name: tag, html_url: 'https://evil.example/x' }));
const bump = (v: string) => {
  const [major, minor, patch] = v.split('-')[0].split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
};

describe('checkForUpdate', () => {
  beforeEach(() => {
    __resetUpdateCheckCache();
    fetchMock.mockReset();
    delete process.env.UPDATE_CHECK_ENABLED;
  });

  it('reports a newer release with a link built from its tag', async () => {
    fetchMock.mockResolvedValueOnce(release(`v${bump(RUNNING)}`));

    await expect(checkForUpdate()).resolves.toEqual({
      current: RUNNING,
      latest: bump(RUNNING),
      updateAvailable: true,
      releaseUrl: `https://github.com/rmyndharis/OpenWA/releases/tag/v${bump(RUNNING)}`,
    });
  });

  it('reports no update when the latest release is the running one', async () => {
    fetchMock.mockResolvedValueOnce(release(`v${RUNNING}`));

    await expect(checkForUpdate()).resolves.toMatchObject({ updateAvailable: false });
  });

  // compareSemver reads a bare `v1` as 0, so an unstripped `v1.0.0` would never beat a 0.x version.
  it('compares a major release correctly despite the v prefix', async () => {
    fetchMock.mockResolvedValueOnce(release('v99.0.0'));

    await expect(checkForUpdate()).resolves.toMatchObject({ latest: '99.0.0', updateAvailable: true });
  });

  it('ignores a tag that is not a plain release version', async () => {
    fetchMock.mockResolvedValueOnce(release('v99.0.0-rc.1'));

    await expect(checkForUpdate()).resolves.toMatchObject({ latest: null, updateAvailable: false, releaseUrl: null });
  });

  it('asks GitHub once per cache window', async () => {
    fetchMock.mockResolvedValue(release('v99.0.0'));

    await checkForUpdate();
    await checkForUpdate();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports no update and backs off when GitHub cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));

    await expect(checkForUpdate()).resolves.toMatchObject({ latest: null, updateAvailable: false });
    await checkForUpdate();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes no request when UPDATE_CHECK_ENABLED=false', async () => {
    process.env.UPDATE_CHECK_ENABLED = 'false';

    await expect(checkForUpdate()).resolves.toEqual({
      current: RUNNING,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the last known release when a later refresh fails', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    fetchMock.mockResolvedValueOnce(release('v99.0.0')).mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await checkForUpdate();
    now.mockReturnValue(1_000 + 7 * 60 * 60_000); // past the six-hour window
    await expect(checkForUpdate()).resolves.toMatchObject({ latest: '99.0.0', updateAvailable: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});

describe('isNewerRelease', () => {
  it.each([
    ['0.23.6', '0.23.5', true],
    ['0.23.5', '0.23.5', false],
    ['0.23.4', '0.23.5', false],
    ['0.23.10', '0.23.9', true],
    // A running prerelease is older than its own final release.
    ['0.24.0', '0.24.0-rc.1', true],
    ['0.23.9', '0.24.0-rc.1', false],
  ])('%s over a running %s is %s', (latest, current, expected) => {
    expect(isNewerRelease(latest, current)).toBe(expected);
  });
});
