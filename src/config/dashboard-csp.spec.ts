import { DASHBOARD_CSP_NONCE_PLACEHOLDER, injectDashboardCspNonce } from './dashboard-csp';

describe('injectDashboardCspNonce', () => {
  it('keeps each dashboard document nonce isolated (multi-tab safe)', () => {
    const template = `<meta name="openwa-csp-nonce" content="${DASHBOARD_CSP_NONCE_PLACEHOLDER}">`;
    expect(injectDashboardCspNonce(template, 'tab-a')).toContain('content="tab-a"');
    expect(injectDashboardCspNonce(template, 'tab-b')).toContain('content="tab-b"');
  });
});
