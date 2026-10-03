/**
 * XenWA team-access permissions.
 *
 * A XenAI Tech user signed in through SSO gets one OPERATOR API key whose `allowedSessions` lists
 * exactly the WhatsApp accounts (sessions) they own or were granted. That reuses the gateway's own
 * session fence (ApiKeyGuard → AuthService.validateApiKey) for the coarse "which accounts" question.
 * The finer "what may they do on THIS account" question is answered here: every request a managed key
 * makes is classified into one permission, and XenwaAccessService refuses it unless the caller owns
 * the session or holds a grant carrying that permission.
 *
 * The classifier is DEFAULT-DENY in both directions: a session route it cannot classify needs the
 * owner, and a global (non-session) route is only reachable when listed in MANAGED_GLOBAL_ROUTES.
 */

export const XENWA_PERMISSIONS = ['read', 'send', 'campaigns', 'contacts', 'settings'] as const;
export type XenwaPermission = (typeof XENWA_PERMISSIONS)[number];

/** A permission plus the special "owner" tier (delete account, manage team). */
export type XenwaRequirement = XenwaPermission | 'owner';

export const XENWA_PERMISSION_LABELS: Record<XenwaPermission, string> = {
  read: 'View chats & messages',
  send: 'Send messages & reply',
  campaigns: 'Run campaigns / broadcasts',
  contacts: 'Manage contacts, groups, labels & templates',
  settings: 'Manage account settings, webhooks & automation',
};

export function isXenwaPermission(value: unknown): value is XenwaPermission {
  return typeof value === 'string' && (XENWA_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Normalize a requested permission list: unknown entries dropped, duplicates removed, and `read`
 * always included (every other permission is useless without seeing the account).
 */
export function normalizePermissions(input: unknown): XenwaPermission[] {
  const list = Array.isArray(input) ? input : [];
  const set = new Set<XenwaPermission>(['read']);
  for (const entry of list) if (isXenwaPermission(entry)) set.add(entry);
  return XENWA_PERMISSIONS.filter(p => set.has(p));
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** First path segment after `sessions/:sessionId/` → permission for a WRITE request. */
const WRITE_SEGMENT_PERMISSION: Record<string, XenwaRequirement> = {
  messages: 'send',
  chats: 'send',
  presence: 'send',
  status: 'send',
  media: 'send',
  calls: 'send',
  contacts: 'contacts',
  groups: 'contacts',
  labels: 'contacts',
  channels: 'contacts',
  templates: 'contacts',
  catalog: 'contacts',
  webhooks: 'settings',
  'automation-rules': 'settings',
  profile: 'settings',
  config: 'settings',
  start: 'settings',
  stop: 'settings',
  logout: 'settings',
  'force-kill': 'settings',
  'pairing-code': 'settings',
  // `proxy` is ADMIN + unscoped already; listed so the classifier never guesses.
  proxy: 'owner',
};

/** READ routes that still need more than `read` (they return a capability or configuration). */
const READ_SEGMENT_PERMISSION: Record<string, XenwaRequirement> = {
  qr: 'settings',
  webhooks: 'settings',
  'automation-rules': 'settings',
  proxy: 'owner',
};

/**
 * Classify a request on a session-dimensioned route.
 *
 * @param method HTTP method
 * @param rest   path segments AFTER `sessions/:sessionId` (e.g. ['messages', 'send-text'])
 */
export function classifySessionRoute(method: string, rest: string[]): XenwaRequirement {
  const verb = method.toUpperCase();
  const [first = '', second = ''] = rest;

  if (READ_METHODS.has(verb)) {
    return READ_SEGMENT_PERMISSION[first] ?? 'read';
  }

  // DELETE /sessions/:id — removing the WhatsApp account itself.
  if (first === '') return 'owner';

  // Side effects of simply LOOKING at a chat (blue ticks, presence) belong to read-only viewers too,
  // otherwise opening the inbox with only "View" would fail on every chat.
  if ((first === 'chats' && second === 'read') || (first === 'presence' && second === 'subscribe')) return 'read';

  // Campaigns: bulk sends and batch control.
  if (first === 'messages' && (second === 'send-bulk' || second === 'batch')) return 'campaigns';

  return WRITE_SEGMENT_PERMISSION[first] ?? 'owner';
}

/**
 * Global routes (no session in the path) a managed key may reach, as `METHOD path` with the `/api`
 * prefix stripped. Each one scopes itself to the key's allowedSessions inside the handler (see the
 * global-route-fence-coverage spec's ALLOWLIST), so reaching it cannot widen what the key sees.
 * Anything else — audit, infra, plugins, settings, key management, integrations, metrics — is refused.
 */
const MANAGED_GLOBAL_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^sessions$/],
  ['GET', /^sessions\/stats\/overview$/],
  ['POST', /^auth\/validate$/],
  ['GET', /^search$/],
  ['GET', /^webhooks$/],
  ['GET', /^health(\/.*)?$/],
  // XenWA's own surface does its own per-user checks.
  ['GET', /^xenwa(\/.*)?$/],
  ['POST', /^xenwa(\/.*)?$/],
  ['PUT', /^xenwa(\/.*)?$/],
  ['PATCH', /^xenwa(\/.*)?$/],
  ['DELETE', /^xenwa(\/.*)?$/],
];

export type RouteDecision =
  | { kind: 'session'; sessionId: string; requirement: XenwaRequirement }
  | { kind: 'global-allowed' }
  | { kind: 'global-denied' };

/**
 * Decide what a managed key needs for a request.
 *
 * @param method    HTTP method
 * @param path      request path, with or without the `/api` prefix and query string
 * @param sessionId the guard-resolved session id (route param), when the route has one
 */
export function decideRoute(method: string, path: string, sessionId?: string): RouteDecision {
  const clean = path
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/^api\/?/, '')
    .replace(/\/+$/, '');
  const segments = clean.split('/').filter(Boolean);
  const verb = method.toUpperCase();

  // stats/sessions/:sessionId — a per-session read.
  if (segments[0] === 'stats' && segments[1] === 'sessions' && segments[2]) {
    return { kind: 'session', sessionId: sessionId ?? decodeURIComponent(segments[2]), requirement: 'read' };
  }

  if (segments[0] === 'sessions' && segments.length >= 2 && !(segments[1] === 'stats' && segments.length === 3)) {
    const id = sessionId ?? decodeURIComponent(segments[1]);
    return { kind: 'session', sessionId: id, requirement: classifySessionRoute(verb, segments.slice(2)) };
  }

  for (const [m, pattern] of MANAGED_GLOBAL_ROUTES) {
    if (m === verb && pattern.test(clean)) return { kind: 'global-allowed' };
  }
  return { kind: 'global-denied' };
}
