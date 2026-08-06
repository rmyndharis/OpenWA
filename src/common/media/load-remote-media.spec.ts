import { fetch as undiciFetch } from 'undici';
import { loadRemoteMediaBuffer } from './load-remote-media';
import { SsrfBlockedError } from '../security/ssrf-guard';

// Media download goes through undici's fetch (via the SSRF-pinning helper); mock it, not global fetch.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

describe('loadRemoteMediaBuffer', () => {
  afterEach(() => {
    (undiciFetch as jest.Mock).mockReset();
    delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
  });

  // Build a Response-like with a single-chunk body stream.
  const fakeResponse = (bytes: number[], headers: Record<string, string>) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () =>
            done
              ? Promise.resolve({ done: true, value: undefined })
              : ((done = true), Promise.resolve({ done: false, value: new Uint8Array(bytes) })),
          cancel: () => Promise.resolve(),
        };
      },
      cancel: () => Promise.resolve(),
    },
  });

  it('blocks an internal URL via the SSRF guard before any fetch', async () => {
    const fetchMock = undiciFetch as jest.Mock;
    await expect(loadRemoteMediaBuffer('http://127.0.0.1/x.png')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a public URL and returns the bytes + content-type', async () => {
    const fetchMock = undiciFetch as jest.Mock;
    fetchMock.mockResolvedValue(fakeResponse([1, 2, 3], { 'content-type': 'image/png', 'content-length': '3' }));
    const res = await loadRemoteMediaBuffer('http://8.8.8.8/x.png');
    expect(res.mimetype).toBe('image/png');
    expect(Array.from(res.data)).toEqual([1, 2, 3]);
    // Never follow redirects (a 3xx could reach an internal host the guard never validated).
    expect(fetchMock).toHaveBeenCalledWith('http://8.8.8.8/x.png', expect.objectContaining({ redirect: 'manual' }));
  });

  it('rejects a body that exceeds the byte cap', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '2';
    (undiciFetch as jest.Mock).mockResolvedValue(fakeResponse([1, 2, 3], { 'content-type': 'image/png' }));
    await expect(loadRemoteMediaBuffer('http://8.8.8.8/x.png')).rejects.toThrow(/exceeds/i);
  });
});
