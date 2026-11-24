// Delay before releasing a Blob object URL after `link.click()` hands off a download.
// Safari/WebKit and Firefox open the Blob stream asynchronously after click returns; revoking
// synchronously can abort the download. Calling `unref()` keeps Node test runs from waiting on the timer.
const BLOB_URL_REVOKE_DELAY_MS = 1000;

export function scheduleObjectUrlRevoke(url: string): void {
  const revoke = typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL.bind(URL) : null;
  if (!revoke) return;
  const timer = setTimeout(() => {
    revoke(url);
  }, BLOB_URL_REVOKE_DELAY_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}
