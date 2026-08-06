# Contributing to OpenWA

Thanks for your interest in improving OpenWA! This guide covers how to get set up, the
conventions we follow, and how to get a change merged. Contributions of all sizes are
welcome — bug fixes, features, docs, and tests.

## Project layout

OpenWA is a NestJS (backend) + React/Vite (dashboard) project:

- `src/` — the NestJS API. Feature modules under `src/modules/` (session, message,
  webhook, queue, audit, settings, infra, …), the WhatsApp engine abstraction under
  `src/engine/`, and shared utilities under `src/common/`.
- `dashboard/` — the React dashboard.
- `docs/` — architecture, API specification, and operational docs.

See `docs/03-system-architecture.md` for the bigger picture.

## Getting started

OpenWA targets **Node.js 22+**.

```bash
# backend
npm install
cp .env.example .env        # adjust as needed
npm run start:dev           # hot-reload, default port 2785

# dashboard (separate terminal)
cd dashboard && npm install && npm run dev
```

Default storage is SQLite, so no external services are required to run locally.

## Before opening a pull request

Please make sure these pass locally:

```bash
npm run build               # NestJS build (tsc)
npm test                    # unit tests (Jest)
npm run lint                # ESLint
npm run format              # Prettier
npm --prefix dashboard run build   # dashboard type-check + build
```

- Add or update tests for behavior changes — specs are colocated as `*.spec.ts`.
- Keep each PR focused on one logical change; it makes review (and credit) much easier.
- Update `docs/` and the `CHANGELOG.md` `[Unreleased]` section when your change is
  user-visible. (Maintainers own version stamping and release cutting.)

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`, etc.
- **Style:** single quotes, 2-space indentation, 120-column width, semicolons — all
  enforced by Prettier + ESLint. Run `npm run format` before committing.
- **Types:** explicit types, avoid `any`.
- **Requests:** validate request bodies with DTOs + `class-validator`.
- **Errors & logging:** throw NestJS HTTP exceptions; use the project `LoggerService`
  (`createLogger`) rather than `console.*`.
- **Database:** changes to the persisted (data) schema need a TypeORM migration under
  `src/database/migrations/`.

## Scope notes (please read before large PRs)

- The default engine is **whatsapp-web.js**. Some capabilities are engine-limited — for
  example, interactive **Buttons / List** messages are not supported on whatsapp-web.js,
  so PRs adding them won't function against the default engine.
- The **REST API is the public contract**. Please avoid changing response shapes or
  status codes without opening an issue to discuss first.
- For substantial architectural changes (new frameworks, large rewrites), please open an
  issue to align on the approach before investing the work.

## Reporting issues

Use the **Bug report** or **Feature request** issue templates — the structured fields
(version, deployment, engine, logs, reproduction) make triage much faster. For security
vulnerabilities, see [`SECURITY.md`](SECURITY.md) — please do **not** open a public issue.

### Issues vs. Discussions — pick the right channel

A large share of opened issues turn out to be configuration, provider, or environment
questions rather than defects in OpenWA. Routing them correctly upfront saves everyone
(time to answer, time to triage, cleaner issue history). When in doubt, open a Discussion
first — it can always be promoted to an Issue if a real defect is confirmed.

| Open an **Issue** (here)                                                 | Open a **Discussion**                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Reproducible defect in OpenWA code with clear steps, expected vs. actual | Setup / configuration help ("my proxy doesn't work, how do I configure X?") |
| Crash, panic, wrong API response, regression after upgrade               | Provider-specific quirks (webshare, IPRoyal, brightdata, Twilio, etc.)      |
| Documented behavior contradicted by actual behavior                      | "Is X possible?" / "What's the best way to Y?"                              |
| Security issue (use `SECURITY.md` instead)                               | Hosting-platform / network / firewall questions                             |

When an Issue lands in the gray zone, maintainers will label it `needs-info`,
`not-a-bug`, or `move-to-discussions`. If after follow-up it turns out to be
environmental or provider-side, it will be closed and we'll continue in Discussions.
The full table and label reference live in
[`docs/20-community-guidelines.md`](docs/20-community-guidelines.md#issue-vs-discussions).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating,
you're expected to uphold it.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
