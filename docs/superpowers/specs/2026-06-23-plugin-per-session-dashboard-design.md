# Per-session plugin dashboard UI (v0.7)

Status: approved 2026-06-23. Dashboard-only; all backend APIs already exist.

## Goal

Surface, in the dashboard, the two per-session capabilities whose backends shipped without UI:

- **Activation (#438):** which sessions a session-scoped plugin runs for — `activeSessions` = `['*']` (all) or an explicit set. API: `PUT /plugins/:id/sessions`.
- **Per-session config (#441):** a per-session config override on top of the base (`'*'`) config — `sessionConfig[sessionId]`. API: `PUT /plugins/:id/config/:sessionId` (empty body clears the override).

The DTO already returns `sessionScoped`, `activeSessions`, `sessionConfig` (secrets redacted per slice). No backend change.

## Design

### 1. API client (`dashboard/src/services/api.ts`)
- Extend `Plugin`: `sessionScoped: boolean`, `activeSessions: string[]`, `sessionConfig?: Record<string, Record<string, unknown>>`.
- `pluginsApi.setSessions(id, sessions: string[])` → `PUT /plugins/:id/sessions` (body `{ sessions }`).
- `pluginsApi.updateSessionConfig(id, sessionId, config)` → `PUT /plugins/:id/config/:sessionId` (body `{ config }`); empty `config` clears.

### 2. Tabbed config modal (`dashboard/src/pages/Plugins.tsx`)
- Tabs render only for a **session-scoped, non-engine** plugin (`type !== 'engine' && sessionScoped !== false`): `[ Configuration ] [ Sessions ]`. Otherwise the modal body is unchanged (no tabs).
- **Configuration tab** = today's base config exactly (B-lite `ConfigField` form / B-full iframe / no-config). Unchanged.
- **Sessions tab** (uses `useSessionsQuery()`):
  - *Activation:* radio **All sessions** (`['*']`) / **Specific** → a checklist of sessions. **Save** → `setSessions(['*'])` or the checked ids. Empty specific set = active for none.
  - *Per-session config* (only if the plugin has `configSchema` or `configUi`): a session `<select>` (all sessions from the query) → edits that session's override:
    - **B-lite:** the existing recursive `ConfigField` form, seeded from the **resolved slice** (base ⊕ override). **Save** PUTs only the top-level keys that **differ from base** (sparse override). **Clear override** PUTs `{}`.
    - **B-full:** reuse `PluginConfigUi` with a new optional `sessionId` prop → bridge `config:get` returns that session's redacted slice (`sessionConfig[sid]` merged over base), `config:save` → `updateSessionConfig(id, sid, cfg)`.

### 3. i18n
New keys (tabs, activation labels, per-session labels, clear-override) added to all 9 locales — the parity gate (`dashboard/scripts/check-i18n-parity.mjs`) must pass.

### 4. CSS (`Plugins.css`)
Tab bar + Sessions-tab sections (activation radio/checklist, per-session picker), matching the existing modal styling.

## Key decisions

- **Sparse overrides (diff-on-save):** the per-session B-lite editor stores only keys that differ from the base, so later base-config edits still propagate to a session's untouched fields. An untouched secret shows `***` (== base) → not in the diff → inherits; a newly-typed secret is stored via the backend's `restoreSecretConfig`.
- **Picker lists ALL sessions** (not just activated ones): overriding config for a session is harmless when inactive (the override only applies while the plugin is active for it), and it works when `activeSessions = ['*']` (no explicit list to pick from).
- **Engine / global plugins:** no Sessions tab.

## Out of scope / YAGNI
- Per-field "inherit vs override" tri-state UI (the sparse diff-on-save covers inheritance without per-field toggles).
- Bulk per-session config (set the same override across many sessions at once).

## Verification
Dashboard `npm run build` (tsc) + `npm run lint` + i18n parity. No jest (the dashboard has no test framework, per project convention); the API-client + render logic are exercised via build typecheck + manual trace. Adversarial review of the diff before merge.
