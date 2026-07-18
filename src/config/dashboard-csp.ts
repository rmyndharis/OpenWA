export const DASHBOARD_CSP_NONCE_PLACEHOLDER = '__OPENWA_CSP_NONCE__';

/** Inject the response-specific CSP nonce into the bundled dashboard document. */
export function injectDashboardCspNonce(html: string, nonce: string): string {
  return html.replace(DASHBOARD_CSP_NONCE_PLACEHOLDER, nonce);
}
