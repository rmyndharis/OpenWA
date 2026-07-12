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
    'Not emitted: an engine-level lifecycle transition, redundant with sessions.status and the SessionService lastDispatchedStatus map. User-initiated lifecycle (SESSION_STARTED / SESSION_STOPPED) is audited.',
  [AuditAction.SESSION_DISCONNECTED]:
    'Not emitted: an engine-level lifecycle transition, redundant with sessions.status and the SessionService lastDispatchedStatus map; reconnect storms would flood the audit log.',
  [AuditAction.MESSAGE_SENT]:
    'Not emitted: per outbound message, fully redundant with the messages table, which persists every send with its outcome.',
  [AuditAction.MESSAGE_FAILED]:
    'Not emitted: per failed send, redundant with the outcome persisted on the messages table.',
  [AuditAction.WEBHOOK_CREATED]:
    'Not yet emitted: webhook create/delete is not currently audited. It is low-volume and security-relevant, so wiring it is a candidate for a separate enhancement; the gate will validate the emission once added, and this entry must then be removed.',
  [AuditAction.WEBHOOK_DELETED]:
    'Not yet emitted: webhook create/delete is not currently audited. It is low-volume and security-relevant, so wiring it is a candidate for a separate enhancement; the gate will validate the emission once added, and this entry must then be removed.',
  [AuditAction.WEBHOOK_TRIGGERED]:
    'Not emitted: per delivery attempt, redundant with the webhook_delivery_failures dead-letter table and the openwa_webhook_delivery_failures_total counter.',
  [AuditAction.WEBHOOK_FAILED]:
    'Not emitted: per failed delivery, redundant with the webhook_delivery_failures dead-letter table and the openwa_webhook_delivery_failures_total counter.',
};
