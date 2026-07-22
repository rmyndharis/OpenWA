# Bridge-hybrid annotation foundation TDD evidence

## Scope

This Phase 3 slice implements only a generic, provider-neutral annotation store and plugin lifecycle
contract. It has no transcription provider, external AI dependency, local bridge adapter, agent behavior,
calendar/CRM integration, annotation HTTP endpoint, or annotation search/read capability.

## Guarantees exercised

- A provider writes only a validated, bounded transcript annotation for a message in its explicit session.
  The scoped parent check selects `messages.id` only; it does not load message body, metadata, or media.
- The provider identity comes from its plugin manifest, and `message-annotations:write` plus session
  activation are enforced before the store is resolved.
- The sandbox IPC router exposes only `annotations.upsert`; there is no annotation get/list/search verb.
- Requested and updated lifecycle hooks are in the finite hook allowlist. Their payloads have only a
  message reference/type or annotation status projection—never transcript text or arbitrary metadata.
- Existing message and webhook projections stay unchanged. The live inbound persistence path invokes the
  minimal lifecycle request only after a durable eligible-media row exists.
- The additive migration has a composite session/message/provider/kind key, is idempotent, and is reversible.

## RED and GREEN evidence

The first focused run failed because the annotation service, migration, and hook names did not exist.
After the implementation, the focused suite below passed with the validation, plugin-boundary, IPC, and
live-persistence regressions in place.

| Command                                                                                                                                                                                                                                                                                                                                                                                                        | Result           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `npm test -- --runInBand modules/message/message-annotation.service.spec.ts modules/message/message.service.spec.ts modules/session/session.service.spec.ts core/hooks/hook.interfaces.spec.ts core/plugins/plugin-capability.spec.ts core/plugins/sandbox/capability-router.spec.ts core/plugins/sandbox/worker-capability.spec.ts database/migrations/__tests__/1782600000000-AddMessageAnnotations.spec.ts` | PASS — 315 tests |

The final verification commands and their actual results are recorded with the Phase 3 handoff.
