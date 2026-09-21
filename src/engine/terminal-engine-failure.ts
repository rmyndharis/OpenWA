/**
 * onError reasons the engine adapters raise for failures an automatic retry cannot fix: each one
 * already carries a remedy only the operator can apply (re-scan, stop another instance, delete a
 * stale profile, resolve an account block). The adapters build their messages from these constants,
 * so the session lifecycle can tell them apart from a failed launch or a network error, which a
 * service-level reconnect retries instead of landing FAILED.
 */
export const AUTH_FAILURE_REASON = 'Authentication failed';
export const STALE_PROFILE_ADVICE = "WhatsApp Web's page context was destroyed during startup.";
export const CONNECTION_REPLACED_REASON = 'Connection replaced by another instance (440)';
export const ACCOUNT_REJECTED_REASON = 'Account rejected by WhatsApp (403)';
export const LOGOUT_CLEANUP_FAILED_REASON = 'Logged out by WhatsApp, but the local credential cleanup failed';

const TERMINAL_PREFIXES = [
  AUTH_FAILURE_REASON,
  CONNECTION_REPLACED_REASON,
  ACCOUNT_REJECTED_REASON,
  LOGOUT_CLEANUP_FAILED_REASON,
];

export function isKnownTerminalEngineFailure(reason: string): boolean {
  return TERMINAL_PREFIXES.some(prefix => reason.startsWith(prefix)) || reason.includes(STALE_PROFILE_ADVICE);
}
