# Bridge-hybrid foundation TDD evidence

## Source and scope

Source design: [`docs/bridge-hybrid-design.md`](../bridge-hybrid-design.md). This Phase 2 slice adds
only generic canonical-identity projection and an opt-in, read-only agent-context endpoint. It does
not add annotations/transcription, local-agent behavior, outbound sends, or integrations.

## User journeys

- As a scoped API consumer, I can obtain a small context for one selected inbound message without
  receiving raw metadata, media, an arbitrary message search, or send capability. The fixed history
  window includes that trigger but excludes messages with a later WhatsApp event timestamp.
- As a scoped API consumer, I receive only typed quote/current-reaction context and aggregate persisted
  receipt status; legacy metadata is never fetched as a fallback.
- As an operator, I can keep this surface absent unless `AGENT_CONTEXT_ENABLED=true` is explicitly
  set.
- As a consumer of WhatsApp identities, I receive a canonical phone JID when a persisted LID mapping
  is known and an explicit unresolved-LID state when it is not.

## RED and GREEN evidence

The initial focused test run after adding tests failed because the new implementation modules did
not exist. After implementation, a repository mock exposed a missing defensive context cap; the
service now slices its result as well as requesting a database-level `take`.

| Guarantee                                                                                                                                                        | Test                                                                                 | Result |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| Phone, resolved LID, unresolved LID, and special JIDs project safely                                                                                             | `src/engine/identity/canonical-identity.spec.ts`                                     | PASS   |
| Context is session/chat bounded, inbound-only, body capped, metadata unselected, and cross-session ids do not disclose existence                                 | `src/modules/agent-context/agent-context.service.spec.ts`                            | PASS   |
| History includes the selected trigger, uses WhatsApp timestamp, excludes post-trigger/backfilled and ambiguous same-second events, and falls back only if absent | `src/modules/agent-context/agent-context.service.spec.ts`                            | PASS   |
| Resolved phone/LID aliases and both direct-user JID dialects share a capped same-session bucket, while unresolved LIDs remain isolated                           | unit regression plus `test/agent-context.e2e-spec.ts`                                | PASS   |
| Typed quote/current-reaction context is bounded and canonicalized; aggregate receipt status is projected                                                         | `src/modules/agent-context/agent-context.service.spec.ts`, endpoint E2E              | PASS   |
| Live inbound quotes, API replies, and reaction upsert/delete write additive typed records while JSON payload compatibility remains                               | `src/modules/session/session.service.spec.ts`, `message.service.spec.ts`             | PASS   |
| Additive quote/reaction migration is idempotent and reversible                                                                                                   | `src/database/migrations/__tests__/1782500000000-AddMessageContextRelations.spec.ts` | PASS   |
| Feature defaults off and requires exact `true`                                                                                                                   | `src/config/feature-flags.spec.ts`                                                   | PASS   |
| Enabled API is viewer-readable, session-scoped, six-entry bounded, GET-only, and feature-gated                                                                   | `test/agent-context.e2e-spec.ts`                                                     | PASS   |

## Verification

| Command                                                                                                                                                                                                                                                                                                              | Result                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npx jest --runInBand --coverage --coverageThreshold='{}' --collectCoverageFrom='engine/identity/canonical-identity.ts' --collectCoverageFrom='modules/agent-context/agent-context.service.ts' engine/identity/canonical-identity.spec.ts modules/agent-context/agent-context.service.spec.ts`                       | PASS — 15 tests; 96.66% statements, 83.6% branches, 100% functions, 98.78% lines           |
| `npm test -- --runInBand engine/identity/canonical-identity.spec.ts config/feature-flags.spec.ts modules/agent-context/agent-context.service.spec.ts modules/session/session.service.spec.ts modules/message/message.service.spec.ts database/migrations/__tests__/1782500000000-AddMessageContextRelations.spec.ts` | PASS — 287 tests                                                                           |
| `npx jest --config test/jest-e2e.json --runInBand test/agent-context.e2e-spec.ts`                                                                                                                                                                                                                                    | PASS — 3 tests                                                                             |
| `npm run lint`                                                                                                                                                                                                                                                                                                       | PASS with one unrelated existing warning in `src/common/utils/dto-strict-coercion.spec.ts` |
| `npx tsc --noEmit`                                                                                                                                                                                                                                                                                                   | PASS                                                                                       |
| `npm run build`                                                                                                                                                                                                                                                                                                      | PASS                                                                                       |

This evidence covers only the generic Phase 2 foundation; local bridge adapters and deployment-specific integrations remain out of scope.
