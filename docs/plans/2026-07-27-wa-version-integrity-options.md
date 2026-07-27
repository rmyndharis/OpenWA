# WhatsApp Web Version Pin — Integrity Options (Decision Request)

- **Status:** Draft — pending maintainer decision
- **Date:** 2026-07-27
- **Scope:** `whatsapp-web.js` engine only (`ENGINE_TYPE=baileys` does not use this mechanism)

This document lays out the structural options for guaranteeing (or consciously not guaranteeing)
the integrity of the WhatsApp Web build that OpenWA pins by default, and asks maintainers to pick
a direction. It proposes no code changes.

## 1. Status quo

With `WWEBJS_WEB_VERSION` unset, `auto`, or `latest` (the default), OpenWA fetches
`versions.json` from the third-party `wppconnect-team/wa-version` registry and pins the newest
non-beta, unexpired build that has been published for at least 12 hours
(`src/engine/wa-web-version.ts:17-20`, `pickSettledWebVersion` at
`src/engine/wa-web-version.ts:85-101`). whatsapp-web.js then downloads the registry's HTML
snapshot for that build at session start and executes it inside the authenticated
`web.whatsapp.com` origin; no hash, signature, or other integrity check exists anywhere on that
path (`src/engine/wa-web-version.ts:48-51`). This default exists because whatsapp-web.js's own
auto-select can latch onto an incompatible build that authenticates and then never reaches
"ready" — the failure class behind #488 (sessions disconnect-looping after QR scan) and #684
(QR never generating) — so the pin is a reliability fix, not an optional optimization. The trust
chain for a default install is therefore: the wppconnect-team registry maintainers and anyone
with push access to that repository, plus GitHub's raw-content delivery over TLS. Transparency
around this is already in place: a once-per-process boot warning naming the source and the
opt-outs (`warnRemoteTrustOnce`, `src/engine/wa-web-version.ts:53-66`), the documented trade-off
in `.env.example:100-112` and `docs/12-troubleshooting-faq.md:283-286`, and the dashboard's
Infrastructure page showing the running build and whether it came from an operator pin, the
registry, or native auto-select (`getEffectiveWebVersionInfo`,
`src/engine/wa-web-version.ts:177-183`; `src/modules/infra/infra.controller.ts:599-615`).
Operators can fully opt out today: `WWEBJS_WEB_VERSION=off` uses the first-party build served by
WhatsApp, and `WWEBJS_WEB_VERSION_REMOTE_PATH` redirects the HTML fetch to an
operator-controlled copy (`src/engine/wa-web-version.ts:68-74`, `156-170`). What remains
undecided is whether the *default* path should gain an integrity guarantee, and if so, how.

## 2. Options

### Option A — Release-shipped hash allowlist

**How it works.** Each OpenWA release would bundle a list of `{ build version → SHA-256 of the
registry HTML }`. At pin time OpenWA downloads the HTML, verifies the hash against the allowlist,
and only then lets whatsapp-web.js execute it (in practice this means pre-fetching and serving
the verified bytes ourselves, since whatsapp-web.js fetches `remotePath` internally).

**Advantages.** Integrity is anchored in the OpenWA release artifact, which operators already
trust; no new standing infrastructure; failure is detectable and loggable.

**Costs / risks.** The allowlist decays fast. WhatsApp Web builds churn on a cadence of days,
while OpenWA releases on a cadence of weeks — so within days of any release the registry's
current settled build is typically one the shipped allowlist does not cover. Every miss forces a
bad choice: fail closed (session refuses to start — an availability regression worse than the
problem being solved), or fall back to unverified/native behavior (which silently voids the
check, or reintroduces the #488/#684 hang class the pin exists to prevent). Keeping the list
fresh requires either release automation that cuts a new OpenWA version every time WhatsApp
publishes a build, or a live-updated hash channel — which is Option B with extra steps. It also
adds new fetch-verify-serve machinery between the registry and whatsapp-web.js.

**Feasibility.** Technically straightforward, operationally self-defeating: the decay rate makes
the check stale exactly when it matters (new installs, new sessions), and its failure modes
recreate the incident class the default was built to avoid. **Not recommended.**

### Option B — Signed hash channel / first-party mirror

**How it works.** OpenWA operates its own mirror of vetted HTML snapshots plus a signed manifest
(mapping build versions to hashes), verified at runtime against a public key pinned in the
release. Integrity then anchors in OpenWA's own signing key rather than in registry content.

**Advantages.** The only option that genuinely closes the integrity gap for default installs
without depending on registry goodwill; the vetting step (what replaces today's 12-hour settle
heuristic) becomes explicit and auditable.

**Costs / risks.** This requires infrastructure the project does not have: signing-key
generation, storage, rotation, and compromise procedures; a CI signing step; hosting with an
uptime obligation (session starts would depend on it unless a fallback is defined); and a
standing process for ingesting and vouching for new builds at WhatsApp's publication cadence.
Mirroring also makes OpenWA the distributor of record for WhatsApp's proprietary web build — a
redistribution posture the project has not taken so far. It is a permanent operational
commitment, not a one-time patch.

**Feasibility.** Real but heavy. Proportionate only if the project is willing to become a build
distributor with key-management duties. Revisit if the re-evaluation criteria in §5 are met.

### Option C — Documented accepted risk, plus stronger opt-out paths

**How it works.** Keep the registry default as the reliability-preserving choice, explicitly
classify the third-party HTML trust as a documented accepted risk (the risk register format of
`docs/16-risk-management.md` is the natural home), and invest in making the opt-outs effortless:
a first-class self-hosting recipe for `WWEBJS_WEB_VERSION_REMOTE_PATH` (mirror one HTML file on
operator infra — integrity then becomes fully operator-controlled), and security-hardening
deployment guidance that recommends `off` or self-hosting for threat-sensitive setups.

**Advantages.** Zero new runtime machinery; no availability regression; the trust decision stays
where it already is (with the operator) but better informed; cost is documentation only.

**Costs / risks.** The default install continues to execute third-party HTML without an
integrity check — the gap is disclosed, not closed. Its honesty depends on the disclosure
staying prominent as the docs evolve. A sub-decision is bundled here: whether the default should
instead flip to `off` (first-party build). Flipping removes the third-party trust dependency
entirely but restores the #488/#684 hang class for default installs — a proven availability and
support-cost regression — so it trades a disclosed trust risk for a demonstrated operational
one. That trade is the core of the maintainer decision.

**Feasibility.** Immediately actionable; consistent with everything already shipped (boot
warning, docs, dashboard source display).

### Option D — Operator-controlled pinning (a constraint, not a standalone option)

Explicit `WWEBJS_WEB_VERSION=<build>` plus `WWEBJS_WEB_VERSION_REMOTE_PATH` already gives an
operator end-to-end control with no reliance on any OpenWA- or registry-side list: the operator
picks the build, hosts the bytes, and can hash-pin them on their own infra. This path needs no
allowlist, no signing channel, and no new OpenWA infrastructure — and Options A–C must never
weaken it. It is listed here as the invariant every acceptable decision must preserve: any
integrity scheme that requires operator pins to consult an OpenWA-maintained list, or that adds
a network dependency to a self-hosted setup, would be a regression against today's guarantees.

## 3. Recommendation (for maintainer decision)

- **Option A** should be ruled out: the allowlist decays faster than the release cadence can
  refresh it, and its failure modes reintroduce the #488/#684 incident class or break session
  startup outright.
- **Option B** is the only option that truly closes the gap, but it demands standing key
  management, hosting, and a build-vetting process the project does not currently operate. It
  should be adopted only as a deliberate, resourced commitment — not as a side feature.
- **Option C** is the lowest-cost honest position: the gap stays disclosed, the opt-outs get
  sharper, and nothing operators rely on today changes. The genuine judgment call it contains —
  keep the registry default, or flip the default to `off` — trades a disclosed third-party
  trust dependency against a demonstrated availability incident class. That weighting is a
  maintainer decision, and this document deliberately does not make it.
- **Option D** is not optional: whichever direction is chosen, the operator-controlled escape
  hatches must keep working exactly as they do now.

## 4. Non-negotiable invariants

Whichever option is chosen, the following must hold:

1. `WWEBJS_WEB_VERSION=off` remains a fully first-party path: no registry fetch, no OpenWA-side
   verification dependency, works on firewalled/offline hosts.
2. Explicit operator pins (`WWEBJS_WEB_VERSION=<build>`, with or without
   `WWEBJS_WEB_VERSION_REMOTE_PATH`) never require consulting an OpenWA- or registry-maintained
   allowlist or signing channel.
3. If any integrity verification is ever added to the default path, it must fail closed — never
   execute unverified content — and a verification failure must be surfaced loudly (logs and
   dashboard), never silently degrade into native auto-select (the #488-prone behavior).
4. Session start must not gain a new mandatory outbound network dependency beyond the one the
   chosen mode already implies.
5. The boot-time trust warning and the dashboard's build/source display are kept and extended to
   any new mechanism.

## 5. Criteria for re-evaluation

Revisit this decision when any of the following becomes true:

- The `wppconnect-team/wa-version` registry is compromised, abandoned, or observed serving
  content that does not match the build it claims to serve.
- The registry (or whatsapp-web.js upstream) starts publishing hashes or signatures for the HTML
  snapshots, making verification cheap — adopt it.
- whatsapp-web.js gains native integrity support in `webVersionCache` (hash pinning, SRI-style
  checks), removing the need for OpenWA-side machinery.
- The WhatsApp Web build cadence slows enough (e.g. monthly) that a release-shipped allowlist
  (Option A) would stay fresh between releases.
- The project acquires release/signing infrastructure and hosting that make Option B a
  proportionate commitment.
- If the default is flipped to `off`: a recurrence pattern of #488/#684-class startup hangs in
  default installs is itself the signal to flip back.
