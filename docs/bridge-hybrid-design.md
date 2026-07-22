# Bridge-hybrid design (Phase 1)

## Status and decision

This is a Phase 1 architecture decision, not an implementation change. It keeps OpenWA a general,
self-hosted WhatsApp gateway and keeps deployment-specific agent behavior in a separate local bridge.
The integration boundary is a versioned, deliberately small event/context contract; it is not a way
to import local context stores, model prompts, calendars, or autonomous business actions into upstream
OpenWA.

```
WhatsApp
   |
   v
OpenWA core ---------------------------------------------------+
  sessions, engines, canonical WhatsApp identity, messages     |
  durable LID resolution, authenticated webhook delivery       | versioned event
  optional generic message-annotation extension point          v
                                                   local bridge
                                                   local-context adapter
                                                   transcription provider
                                                   policy + approval ledger
                                                             |
                                                             v
                                                    operator / local agent
```

The right hand side is deployment-local and is never packaged as a default OpenWA plugin. It may
run on the same trusted machine only when the operator accepts that trust boundary; otherwise it
must run in a separately contained process/service with a narrowly scoped OpenWA credential.

## Evidence in the current code

| Concern                 | Existing evidence                                                                                                                                                                                        | Design consequence                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Engine-neutral messages | `src/engine/adapters/baileys-message-mapper.ts` maps Baileys events into `IncomingMessage`; `src/engine/interfaces/whatsapp-engine.interface.ts` is the shared engine contract.                          | Upstream owns WhatsApp protocol and the neutral message model.                                                                          |
| LID ownership           | `src/engine/identity/lid-mapping.entity.ts` and `lid-mapping-store.service.ts` persist a global, cross-session `lid -> phone` cache with negative results and provenance.                                | Do not duplicate or override LID resolution in the local bridge.                                                                        |
| Message extensibility   | `src/modules/message/entities/message.entity.ts` already has a JSON `metadata` field.                                                                                                                    | A typed annotation contract can be introduced additively, but local-context data must not become an unbounded blob in generic metadata. |
| Delivery boundary       | `src/modules/webhook/webhook.service.ts` creates idempotency/delivery ids, supports filters and hooks, and `src/modules/queue/processors/webhook.processor.ts` retries deliveries.                       | The bridge should consume a versioned OpenWA webhook rather than reach into the OpenWA database.                                        |
| Plugin boundary         | `src/core/plugins/plugin.interfaces.ts` has manifest permissions, session scope, ingress routes, and `ctx.net.fetch`; `docs/23-plugin-sandboxing.md` documents that worker threads are not OS isolation. | Plugins are appropriate for generic extensions, not for untrusted code with access to private local context.                            |
| Local bridge behavior   | A separate local bridge may own SQLite aliases, transcripts, and agent workflows.                                                                                                                        | Preserve these as local adapters while replacing only transport/identity duplication over time.                                         |

## Ownership boundaries

### Upstream OpenWA owns

- Engine lifecycle, session authentication, message ingest/send, media acquisition, and the
  canonical neutral JID representation.
- LID-to-phone resolution, its cache invalidation/negative-result semantics, and mapping
  provenance. Consumers receive the canonical identity plus resolution state; they do not write a
  competing alias map.
- Authenticated, scoped external delivery; retries; idempotency; webhook filtering; plugin
  manifest validation; and generic audit/operational telemetry.
- A generic transcription/derived-content annotation _contract_, but not an opinionated provider,
  a deployment-specific transcript policy, or an AI prompt.

### Local bridge owns

- Which OpenWA session(s) are eligible for the configured deployment, local credentials, recipient
  allow/block policy, model selection, style corpus, local-context retrieval, and all calendar/CRM/booking
  integrations.
- The meaning of a transcript for that operator, provider choice and consent, source-media
  retention, prompt construction, action classification, approval records, and local audit data.
- Its own LID compatibility read model only during migration. It treats OpenWA's canonical identity
  as authoritative and must never infer a phone number from a LID.

### Explicit non-goals

- No local bridge-specific schema, vector store, calendar credential, contact list, or model key in
  OpenWA configuration, database migrations, default plugins, SDKs, or webhook payloads.
- No generic OpenWA auto-reply/booking agent in Phase 1.
- No reverse dependency: OpenWA must start, send, receive, and operate normally if the local
  bridge is absent, offline, rejected, or deleted.

## LID identity and resolution

OpenWA becomes the sole resolver once the hybrid is enabled. The bridge receives the following
identity shape in each event/context result:

```ts
type PartyIdentityV1 = {
  canonicalJid: string; // OpenWA neutral JID, never guessed by the bridge
  sourceJid?: string; // raw/engine JID only when policy permits debugging exposure
  kind: 'person' | 'group' | 'broadcast' | 'unknown';
  resolution: 'phone-resolved' | 'lid-unresolved' | 'not-applicable';
  phoneE164?: string; // present only for a resolved person and authorized consumer
  mappingObservedAt?: string;
};
```

Rules:

1. The adapter normalizes before persistence and event construction. A raw `@lid` that cannot be
   resolved remains a stable `@lid` canonical id with `lid-unresolved`; it is not dropped, replaced
   by a guessed phone, or merged through name matching.
2. OpenWA's `LidMappingStore` remains the read/write authority. A resolved mapping is included as
   an observation, not a permanent identity claim; the existing last-write-wins behavior recognises
   number recycling.
3. The bridge keys local policy and approval records by `{openwaInstanceId, sessionId,
canonicalJid}`. Existing `jid_aliases` are migration-only compatibility data, not a second
   resolver.
4. A LID mapping change emits a generic `identity.resolved`/`identity.changed` event with opaque
   previous/current canonical identifiers. The bridge rekeys its local view transactionally and
   retains an alias redirect. It must not re-send or re-run a request merely because identity changed.

## Bounded agent-context surface

The agent does not get a general database query, a shell, an OpenWA admin key, or the whole chat
history. The bridge creates a short-lived `AgentContextV1` from an inbound delivery, and exposes it
only to the configured local agent through a local authenticated IPC/API boundary.

```ts
type AgentContextV1 = {
  schema: 'openwa.agent-context.v1';
  delivery: { id: string; idempotencyKey: string; occurredAt: string };
  session: { id: string; label?: string };
  message: {
    id: string;
    canonicalChat: PartyIdentityV1;
    sender: PartyIdentityV1;
    direction: 'incoming';
    type: string;
    body?: string;
    quotedMessage?: { id: string; body?: string; type: string };
    annotationRefs: Array<{ provider: string; kind: 'transcript'; status: string; ref: string }>;
  };
  conversation: {
    recent: Array<{ id: string; direction: string; body?: string; type: string; occurredAt: string }>;
    maxItems: number;
  };
  localContext?: { items: Array<{ source: string; text: string; expiresAt?: string }>; maxChars: number };
  permittedActions: Array<'draft.reply' | 'request.approval'>;
  expiresAt: string;
};
```

The bridge selects at most one inbound message, its quoted message, a fixed recent same-chat window,
and a character-capped local-context result. It strips raw protocol JSON, arbitrary media bytes,
contact lists, unrelated chats, access tokens, hidden prompt/configuration, and all historical
messages outside that window. Transcript text is fetched by an opaque reference only after the local
policy approves it. Context is single-delivery, tenant/session scoped, non-replayable after expiry,
and logged as a digest/count rather than prompt text.

`draft.reply` can create a proposed text only. It cannot call OpenWA send endpoints. Any agent tool
that needs more data returns a structured `context_insufficient` result for an operator decision;
it must not silently broaden its query.

### Implemented Phase 2 boundary (generic, opt-in)

The current upstream foundation is disabled unless `AGENT_CONTEXT_ENABLED=true` and exposes only
`GET /api/sessions/:sessionId/agent-context/messages/:messageId`. It accepts an explicitly selected
inbound message UUID; there is no list, search, pagination, send, or write endpoint. The response
contains canonical chat/sender identities, a body capped at 1,000 characters, an aggregate persisted
`receipt.status` (`pending`, `sent`, `delivered`, `read`, or `failed`), and at most six same-session
messages from a bounded canonical-equivalent raw-chat bucket.

The six-message conversation is an event-time window **anchored at and including the selected
trigger**. It includes rows with an earlier WhatsApp `Message.timestamp` plus the exact trigger row.
Because timestamps are second-granularity and persisted UUIDs are random rather than engine sequence
keys, other same-second rows are deliberately omitted rather than risk including a later event. Rows
with a later WhatsApp timestamp are excluded even if they arrived in the database earlier; `createdAt`
is used only when a legacy row has no WhatsApp timestamp. `occurredAt` follows the same rule.

Its raw-chat filter starts with the trigger JID and, only when the in-memory LID cache proves a phone
mapping, adds both direct-user dialects (`phone@c.us` and `phone@s.whatsapp.net`) plus up to 30
currently mapped LID aliases (32 IDs total). An unresolved LID remains an isolated one-ID bucket; the
endpoint never guesses a phone, performs a network lookup, or reads a broad identity table. The
message reads select only the fields that are projected or needed for this cutoff; `metadata`
(including media/protocol JSON) is not read.

Quote context is `{ messageId, body? }` from the additive typed `message_quotes` record, with the
same body cap. Reactions are current state from additive typed `message_reactions`, capped at 16 per
projected message and canonically identifying the reacting party. Existing `messages.metadata` quote
and reaction shapes are still maintained for compatibility with current dashboard/webhook consumers,
but the agent-context endpoint neither fetches nor falls back to them. Old rows therefore omit this
optional enrichment rather than exposing raw metadata or inventing data.

## Transcription metadata extension point

OpenWA should expose a provider-neutral derived-content model rather than embed a particular speech
API. Prefer a new additive `message_annotations` store and typed service over overloading the
unvalidated `Message.metadata` object:

```ts
type MessageAnnotationV1 = {
  messageId: string;
  provider: string; // e.g. 'local-whisper' or deployment-specific id
  kind: 'transcript';
  status: 'pending' | 'complete' | 'failed' | 'expired';
  language?: string;
  text?: string; // access-controlled, never in default webhooks
  mediaFingerprint?: string; // verify attachment, not a media path
  createdAt: string;
  expiresAt?: string;
  provenance: { processorVersion: string; externalProcessing: boolean };
};
```

Phase 3 implements the foundation: `message:annotation-requested` fires for an eligible persisted media
row with only `{ messageId, kind, messageType }`; `message:annotation-updated` emits a text-free status
projection after a provider writes a validated annotation. A provider is opt-in and session-scoped. Its
only new capability is `message-annotations:write`, which binds the annotation provider to its manifest
id and has no get/list/search operation. Media retrieval remains a future, separately permissioned
`media:read` decision.

This foundation intentionally does **not** change the default message or webhook projection and exposes
no annotation HTTP API. A future authenticated, session-scoped annotation-read contract may add an
explicit `includeAnnotations=transcript` opt-in; it must not make transcripts part of ordinary webhooks,
SDK responses, or agent context by default.

The local bridge's current `src/transcribe.ts` can be adapted as one provider. Its current generic
upload filename and 25 MiB bound are useful implementation evidence, but its OpenAI dependency is
strictly local policy: an external processor requires operator consent and `externalProcessing:true`.
`src/transcribe-backlog.ts` maps naturally to an annotation worker; it must not read OpenWA storage
directly.

## Webhook and plugin boundaries

1. **Outbound OpenWA webhook → local bridge:** register a dedicated, session-scoped webhook with
   only `message.received`, `identity.*`, and `message.annotation-updated`. Use OpenWA's delivery and
   idempotency values. The bridge validates a secret/signature, stores a short dedup record, and ACKs
   before doing slow transcription or model work. Its current `src/webhook.ts` retry code is replaced
   by the upstream delivery/retry behavior, not duplicated.
2. **Bridge → OpenWA:** use a dedicated bridge API key/client with read access to the bounded context
   endpoint and a separate proposed-message submission endpoint. It receives no plugin-management,
   raw database, arbitrary-session, or general administration rights.
3. **Generic OpenWA plugins:** may implement a transcription provider or integration transport with
   declared permissions and session activation. They must be general-purpose, configurable, and safe
   without the local bridge.
4. **Deployment-specific integration:** stays an external service or a built-in locally deployed adapter, never
   an installable third-party plugin. OpenWA's documented worker-thread sandbox is not confidentiality
   isolation, so it is insufficient for local-context data or calendar credentials on its own.
5. **Ingress:** third-party systems (calendar/booking providers) terminate at the local bridge. They
   do not claim an OpenWA plugin ingress route or receive WhatsApp data until the bridge authenticates
   them and produces an approval request.

## Approval-required actions

The local bridge has a deny-by-default action classifier. The following intents always require an
operator approval tied to an immutable preview and expiry: creating, accepting, declining, moving,
or cancelling a **meeting**; recording or changing **interest**/lead state; revealing or committing
**availability**; and any **booking**, payment-adjacent reservation, or external CRM/calendar write.

An approval record contains the normalized action, target system, canonical chat identity, exact
outbound message, structured parameters, source delivery id, policy version, content hash, creator,
created/expiry timestamps, and final decision. Approval is single use; a changed parameter, recipient,
or text invalidates it. The execution worker verifies the approval immediately before the external
write and records the result/idempotency key. A conversational "yes" from the remote WhatsApp party
is evidence for a _draft_, never the operator's approval.

Ordinary reply drafts are also human-approved by default. If a later deployment permits narrowly
scoped automatic replies, it may only send an already-created draft under a local policy and still
must exclude all four intent classes. This preserves the useful guardrails in
the local bridge's autoreply-safety module, whose scheduling/meeting pattern should fail safe.

## Privacy and retention

| Data                                                   | Location and default rule                                                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw WhatsApp messages/media and canonical LID mappings | OpenWA's existing data store; retention follows its operator configuration. Do not copy the raw store to the bridge.                                                                   |
| Webhook event                                          | Bridge encrypted/local queue only; dedup and delivery metadata retained 30 days by default, payload deleted after successful context creation (or 24 hours on failure).                |
| Agent context and prompt                               | Memory only where possible; otherwise encrypted local storage, 24-hour TTL. Store audit hashes, item counts, and policy ids rather than full prompt text.                              |
| Transcript                                             | Annotation access controlled; default 30-day TTL after completion, with source-media path never exported. Delete/expire when the parent message/media is deleted or retention expires. |
| Local-context retrieval                                | Query and selected snippets remain local; cap characters and results, do not persist prompts, and never send to a model/provider without explicit configured consent.                  |
| Approval/audit ledger                                  | Minimal structured record (no unnecessary message bodies), 90-day default configurable retention, then delete or aggregate.                                                            |

All bridge secrets belong in its private deployment environment. OpenWA webhook logs, failure records,
and plugin diagnostics must redact body/transcript/phone values by default. Exporting a transcript,
local-context snippet, or identifier to an external LLM, transcription service, calendar, CRM, or
notification target is an explicit data-transfer policy decision, not an implied side effect of
enabling the integration.

## Migration and compatibility

1. Add the generic contracts disabled by default. Existing message APIs, webhook payloads, SDKs,
   plugins, engines, and `Message.metadata` remain byte-compatible; annotation fields are additive
   and opt-in.
2. Register an OpenWA webhook to the bridge in shadow mode. The bridge consumes and deduplicates
   deliveries but makes no sends, external calls, or local-context queries. Compare counts and
   canonical identities against its SQLite view.
3. Enable OpenWA identity as the bridge read authority. Import only confirmed `jid_aliases` records
   as migration hints; unresolved or conflicting aliases remain unresolved and are reviewed, never
   force-merged. Preserve local alias redirects for historic lookup.
4. Move transcription to the annotation contract in shadow mode. Compare status/text hashes; keep
   the existing bridge `messages.transcript` only as a local compatibility cache until the configured
   retention window passes.
5. Switch event transport to the OpenWA webhook. Keep the bridge's existing inbound sender disabled
   rather than running two live paths. Use delivery/idempotency keys to make cutover retry-safe.
6. Enable bounded agent context and approvals with draft-only behavior. A rollback disables the
   dedicated webhook/bridge credential and restores bridge-only reads; no core data migration is
   destructive.

## Implementation sequence and verification

| Step                        | Planned source paths                                                                                                                                                                            | Tests / acceptance evidence                                                                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Freeze contracts         | Add `src/modules/message/annotations/*`, extend `src/modules/message/entities/message.entity.ts`, and add a migration under `src/database/migrations/`.                                         | New annotation DTO/service unit tests; migration smoke test; existing `src/modules/message/**/*.spec.ts` unchanged.                                                                                                                                                                                |
| 2. Canonical identity event | Extend `src/engine/identity/lid-mapping-store.service.ts`, `src/engine/adapters/baileys-message-mapper.ts`, and webhook payload construction in `src/modules/webhook/webhook.service.ts`.       | Extend `src/engine/identity/lid-mapping-store.spec.ts` and `src/engine/adapters/baileys-message-mapper.spec.ts` for resolved, unresolved, remapped, and group identities; webhook idempotency/filter regressions in `src/modules/webhook/webhook.service.spec.ts` and `test/webhooks.e2e-spec.ts`. |
| 3. Annotation extension     | Add typed hook/permission support in `src/core/hooks/*`, `src/core/plugins/plugin.interfaces.ts`, and `src/core/plugins/plugin-activation.ts`; create a disabled example provider fixture only. | Manifest permission-denial and session-scope tests in `src/core/plugins/*.spec.ts`; annotation lifecycle, TTL, and no-transcript-in-default-webhook tests.                                                                                                                                         |
| 4. Bounded bridge client    | Add a dedicated read/proposal controller under `src/modules/agent-context/` and register it in the app/module graph. Keep it outside broad `src/core/agent-tools/tools/message.tools.ts`.       | E2E tests prove scope, TTL, max recent items/chars, body/media omission, no arbitrary-history route, and denial of send/admin endpoints.                                                                                                                                                           |
| 5. Local adapter            | In a separate local bridge deployment, add an OpenWA client/consumer beside its webhook handler; adapt its transcription, context, and autoreply modules without changing local data semantics. | Add focused local-bridge tests for event dedup, LID rekey, context bounds, transcript-reference authorization, and no outbound action in shadow mode. Run that deployment's typecheck.                                                                                                             |
| 6. Approval executor        | Add bridge-local `src/approvals.ts` and connector adapters; leave OpenWA send APIs unchanged.                                                                                                   | Tests for all required action classes, exact-preview hash mismatch, expiry, double-submit, connector failure/retry idempotency, and audit redaction.                                                                                                                                               |
| 7. Cutover                  | Deployment/runbook documentation only after shadow metrics pass.                                                                                                                                | `npm run lint`, `npm test`, `npm run test:e2e`, and `npm run build` in OpenWA; bridge `npm run typecheck` plus its targeted tests; a manual rollback drill.                                                                                                                                        |

## Risks and blockers

- **Plugin isolation is not enough for sensitive local data.** The current OpenWA worker-thread
  model runs under the same OS user and can access Node facilities; local adapters need explicit
  process/OS containment or equivalent trusted deployment controls.
- **There is no existing typed annotation capability or bounded agent-context API.** They are new
  generic upstream work and must be designed/reviewed before a bridge can rely on them.
- **LID mappings are observations, not proof of identity.** Migration must surface conflicts instead
  of collapsing aliases automatically; this is especially important for old bridge data.
- **OpenWA and the bridge currently have different storage/session models.** OpenWA is multi-session
  and server-oriented; the bridge is intentionally one paired number with SQLite. The adapter must
  explicitly select an allowed session.
- **External transcription and local-context retrieval are data exports.** Provider consent,
  retention configuration, and outage behavior must be settled before enabling them beyond local
  shadow mode.
- **No implementation or configuration changes are made by this Phase 1 document.**
