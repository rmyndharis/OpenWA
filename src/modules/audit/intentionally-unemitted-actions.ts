import { AuditAction } from './entities/audit-log.entity';

/**
 * Audit actions that are deliberately not emitted, each with the reason. The coverage gate in
 * `audit-coverage.spec.ts` fails for any `AuditAction` that is neither emitted somewhere in `src/`
 * nor listed here, so this registry is the only way an unemitted action can exist without failing
 * the build — every entry is a deliberate, documented decision rather than a silent gap.
 *
 * The gate is honest in both directions:
 *  - a newly-added action with no emission and no entry here fails the build;
 *  - an entry here whose action is in fact emitted is "stale" and also fails the build.
 *
 * To start auditing one of these events: wire its emission at the right call site, then remove its
 * entry here.
 */
export const INTENTIONALLY_UNEMITTED_ACTIONS: Partial<Record<AuditAction, string>> = {
  [AuditAction.API_KEY_USED]:
    'Not emitted: would fire on every authenticated request, which is too high-volume for the audit log. Authentication failures are audited (API_KEY_AUTH_FAILED); successful authentication is intentionally not.',
  [AuditAction.SESSION_CONNECTED]:
    'Not emitted: an engine-level lifecycle transition, redundant with sessions.status and the SessionEngineLifecycle lastDispatchedStatus map. User-initiated lifecycle (SESSION_STARTED / SESSION_STOPPED) is audited.',
  [AuditAction.MESSAGE_SENT]:
    'Not emitted: per outbound message, fully redundant with the messages table, which persists every send with its outcome.',
  [AuditAction.MESSAGE_FAILED]:
    'Not emitted: per failed send, redundant with the outcome persisted on the messages table.',
  [AuditAction.WEBHOOK_TRIGGERED]:
    'Not emitted: per delivery attempt, redundant with the webhook_delivery_failures dead-letter table and the openwa_webhook_delivery_failures_total counter.',
  [AuditAction.WEBHOOK_FAILED]:
    'Not emitted: per failed delivery, redundant with the webhook_delivery_failures dead-letter table and the openwa_webhook_delivery_failures_total counter.',
};
