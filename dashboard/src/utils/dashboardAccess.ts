/**
 * Backend capabilities every dashboard page needs just to render its primary surface.
 *
 * Keep this page-level only: write actions inside a readable page remain independently guarded by
 * the backend. Both App routes and Layout navigation consume this same map so a hidden link can
 * never leave a directly reachable route behind.
 */
export const DASHBOARD_PAGE_CAPABILITIES = {
  '/': ['stats:read', 'sessions:read'],
  '/sessions': ['sessions:read'],
  '/chats': ['chats:read', 'messages:read'],
  '/number-checker': ['contacts:read', 'sessions:read'],
  '/webhooks': ['webhooks:read'],
  '/templates': ['templates:read'],
  '/api-keys': ['apikeys:manage'],
  '/message-tester': ['messages:send', 'sessions:read'],
  '/infrastructure': ['infra:read'],
  '/plugins': ['plugins:read'],
  '/logs': ['audit:read'],
} as const;

export type DashboardPagePath = keyof typeof DASHBOARD_PAGE_CAPABILITIES;

/** A page is unavailable when the key blocks any capability its primary surface requires. */
export function canAccessDashboardPage(path: DashboardPagePath, deniedPermissions: readonly string[]): boolean {
  return !DASHBOARD_PAGE_CAPABILITIES[path].some(capability => deniedPermissions.includes(capability));
}
