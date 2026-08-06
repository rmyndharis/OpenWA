import { generateSafeLinkPreview } from './safe-link-preview';
import * as ssrfGuard from '../../common/security/ssrf-guard';

/**
 * This generator exists because the library's own delegates to a package with an unfixed SSRF
 * advisory, and its input is attacker-influenced — a URL pasted into a message makes this server
 * fetch it. So the tests that matter most are not about parsing: they are that nothing is fetched
 * outside the guard, that non-http schemes never reach the fetch layer at all, and that a hostile or
 * broken response can never turn into a failed send.
 */
describe('generateSafeLinkPreview', () => {
  let withSafeFetch: jest.SpyInstance;

  /** Stand in for the guard, handing the callback a response with the given body/headers. */
  const respondWith = (body: string, contentType = 'text/html', ok = true): void => {
    withSafeFetch = jest.spyOn(ssrfGuard, 'withSafeFetch').mockImplementation((_url, _init, use) =>
      Promise.resolve(
        use({
          ok,
          headers: { get: (name: string) => (name === 'content-type' ? contentType : null) },
          body: null,
          text: () => Promise.resolve(body),
        } as never),
      ),
    );
  };

  afterEach(() => jest.restoreAllMocks());

  describe('the fetch never escapes the guard', () => {
    it('goes through withSafeFetch, not a bare fetch', async () => {
      respondWith('<title>Example</title>');

      await generateSafeLinkPreview('https://example.com/a');

      expect(withSafeFetch).toHaveBeenCalledTimes(1);
      expect((withSafeFetch.mock.calls[0] as unknown[])[0]).toBe('https://example.com/a');
    });

    // The guard rejects a blocked destination by throwing. That must surface as "no preview", never
    // as a failed send — and never as a leaked internal address in an error message.
    it('returns nothing when the guard refuses the destination', async () => {
      jest
        .spyOn(ssrfGuard, 'withSafeFetch')
        .mockRejectedValue(new ssrfGuard.SsrfBlockedError('blocked 169.254.169.254'));

      await expect(generateSafeLinkPreview('http://169.254.169.254/latest/meta-data')).resolves.toBeUndefined();
    });

    // Non-http schemes are the shapes an attacker reaches for, and the fetch layer should never be
    // asked about them at all.
    it.each(['file:///etc/passwd', 'ftp://internal/secrets', 'javascript:alert(1)', 'data:text/html,x'])(
      'refuses %s without fetching',
      async raw => {
        const spy = jest.spyOn(ssrfGuard, 'withSafeFetch');

        await expect(generateSafeLinkPreview(raw)).resolves.toBeUndefined();

        expect(spy).not.toHaveBeenCalled();
      },
    );

    it('does not fetch an unparseable URL', async () => {
      const spy = jest.spyOn(ssrfGuard, 'withSafeFetch');

      await expect(generateSafeLinkPreview('http://[not a host]')).resolves.toBeUndefined();

      expect(spy).not.toHaveBeenCalled();
    });

    // A bare host is what people actually paste, and treating it as https is what a reader does.
    it('adds https to a scheme-less URL rather than refusing it', async () => {
      respondWith('<title>Example</title>');

      await generateSafeLinkPreview('example.com/path');

      expect((withSafeFetch.mock.calls[0] as unknown[])[0]).toBe('https://example.com/path');
    });
  });

  describe('what it extracts', () => {
    it('prefers Open Graph metadata', async () => {
      respondWith(
        `<html><head><title>Fallback</title>
         <meta property="og:title" content="Real title">
         <meta property="og:description" content="Real description"></head></html>`,
      );

      await expect(generateSafeLinkPreview('https://example.com')).resolves.toEqual({
        'matched-text': 'https://example.com',
        'canonical-url': 'https://example.com/',
        title: 'Real title',
        description: 'Real description',
      });
    });

    it('falls back to the document title', async () => {
      respondWith('<html><head><title>Just a title</title></head></html>');

      await expect(generateSafeLinkPreview('https://example.com')).resolves.toMatchObject({
        title: 'Just a title',
      });
    });

    // matched-text is what WhatsApp anchors the preview to in the message body, so it must be the
    // text that appeared there — not the normalised URL that was fetched.
    it('keeps the matched text verbatim while reporting the normalised URL separately', async () => {
      respondWith('<title>T</title>');

      const info = await generateSafeLinkPreview('example.com');

      expect(info?.['matched-text']).toBe('example.com');
      expect(info?.['canonical-url']).toBe('https://example.com/');
    });

    // WhatsApp requires a title. The hostname is a fact about the URL rather than an invention.
    it('uses the hostname when the page has a description but no title', async () => {
      respondWith('<meta property="og:description" content="Only a description">');

      await expect(generateSafeLinkPreview('https://news.example.com/a')).resolves.toMatchObject({
        title: 'news.example.com',
        description: 'Only a description',
      });
    });

    it('decodes the entities that show up in real metadata', async () => {
      respondWith('<meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;show&quot;">');

      await expect(generateSafeLinkPreview('https://example.com')).resolves.toMatchObject({
        title: 'Tom & Jerry\'s "show"',
      });
    });

    // Decoding the ampersand first would turn `&amp;lt;` into `<`.
    it('does not double-decode', async () => {
      respondWith('<meta property="og:title" content="&amp;lt;script&amp;gt;">');

      await expect(generateSafeLinkPreview('https://example.com')).resolves.toMatchObject({
        title: '&lt;script&gt;',
      });
    });
  });

  describe('when there is nothing worth showing', () => {
    it('returns nothing for a page with neither title nor description', async () => {
      respondWith('<html><body>no metadata here</body></html>');

      await expect(generateSafeLinkPreview('https://example.com')).resolves.toBeUndefined();
    });

    // Reading a non-document means pulling an arbitrary binary into memory for no metadata.
    it.each(['image/png', 'application/octet-stream', 'application/pdf'])(
      'returns nothing for a %s response',
      async contentType => {
        respondWith('<title>ignored</title>', contentType);

        await expect(generateSafeLinkPreview('https://example.com')).resolves.toBeUndefined();
      },
    );

    it('returns nothing for a non-ok response', async () => {
      respondWith('<title>Not found</title>', 'text/html', false);

      await expect(generateSafeLinkPreview('https://example.com')).resolves.toBeUndefined();
    });

    // A preview is decoration. A slow or broken site must never turn into a failed message send.
    it('returns nothing when the fetch throws', async () => {
      jest.spyOn(ssrfGuard, 'withSafeFetch').mockRejectedValue(new Error('socket hang up'));

      await expect(generateSafeLinkPreview('https://example.com')).resolves.toBeUndefined();
    });
  });
});
