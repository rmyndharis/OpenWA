# Filas OpenWA — Bull Board embed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menu Filas OpenWA abre o Bull Board real (`/api/admin/queues`) embutido no `main-content` do dashboard, autenticado sem `?apiKey` na URL.

**Architecture:** Cookie bridge same-origin: a página Filas chama `POST /api/admin/queues-board-session` com a `X-API-Key` da sessão; o servidor seta cookie HttpOnly com Path `/api/admin/queues`; o iframe carrega `/api/admin/queues` e o `BullBoardAuthMiddleware` aceita o cookie. `companion_operator` permanece GET/HEAD only.

**Tech Stack:** NestJS + Express Bull Board (`@bull-board/express`), React dashboard (Vite), cookie HttpOnly, testes Jest (backend) + `node --test` (dashboard).

**Spec:** `docs/superpowers/specs/2026-09-12-filas-bull-board-embed-design.md`

## Global Constraints

- Sem `?apiKey` (ou qualquer secret) na URL do board ou do iframe.
- Sem reinventar Design System do shell — só conteúdo do board no `main-content`.
- `companion_operator`: read-only no board (GET/HEAD); ADMIN muta.
- Same-instance only (mesmo origin da dashboard); não reintroduzir `REMOTE_OPENWA_*`.
- Manter menu `/filas-openwa`, role allowlist e i18n `nav.filasOpenWa`.
- Cookie: `HttpOnly`, `Secure` em HTTPS, `SameSite=Strict`, `Path=/api/admin/queues`.
- Nome do cookie: `openwa_bb_key` (constante exportada).

---

## File map

| File | Responsibility |
|------|----------------|
| `src/modules/queue/queues-board-session.constants.ts` | Nome do cookie + Path + Max-Age |
| `src/modules/queue/queues-board-session.controller.ts` | `POST` mint / `DELETE` clear cookie |
| `src/modules/queue/queues-board-session.controller.spec.ts` | Testes do mint |
| `src/common/security/bull-board-auth.middleware.ts` | `extractKey` também lê cookie |
| `src/common/security/bull-board-auth.middleware.spec.ts` | Specs cookie + regressão header |
| `src/modules/queue/queue.module.ts` (ou `infra.module` / `auth`) | Registrar controller |
| `dashboard/src/services/api.ts` | `queuesBoardSessionApi.mint()` / `clear()` |
| `dashboard/src/pages/OpenWaQueues.tsx` | Mint → iframe embed |
| `dashboard/src/pages/OpenWaQueues.css` | Iframe full main-content |
| `dashboard/src/pages/OpenWaQueues.test.ts` | Smoke iframe + mint stub |
| `dashboard/src/i18n/locales/*.json` | Strings de loading/erro do embed |

---

### Task 1: Cookie constants + mint controller (TDD)

**Files:**
- Create: `src/modules/queue/queues-board-session.constants.ts`
- Create: `src/modules/queue/queues-board-session.controller.ts`
- Create: `src/modules/queue/queues-board-session.controller.spec.ts`
- Modify: `src/modules/queue/queue.module.ts` (register controller when queues enabled) **or** `src/modules/infra/infra.module.ts` if QueueModule is optional — prefer registering on a module that always loads for dashboard admins; use `AuthModule` export pattern. **Decision locked:** put controller in `src/modules/auth/` only if queue module is off breaks Filas — Filas board already requires `QUEUE_ENABLED`. Register in `QueueModule` and document that Filas embed needs queues enabled (same as board today).

**Interfaces:**
- Consumes: `AuthService.canAccessOpenWaQueues`, `@CurrentApiKey()` / existing ApiKey decorator, Express `Res` for `Set-Cookie`
- Produces: `QUEUES_BOARD_COOKIE_NAME = 'openwa_bb_key'`, `QUEUES_BOARD_COOKIE_PATH = '/api/admin/queues'`, `QUEUES_BOARD_COOKIE_MAX_AGE_SEC = 3600`, `POST /api/admin/queues-board-session` → 204 + Set-Cookie, `DELETE` → 204 + clear

- [ ] **Step 1: Write the failing test**

```typescript
// queues-board-session.controller.spec.ts
describe('QueuesBoardSessionController', () => {
  it('sets HttpOnly cookie for companion_operator with canAccessOpenWaQueues', async () => {
    const res = { cookie: jest.fn(), clearCookie: jest.fn() };
    const auth = { canAccessOpenWaQueues: () => true };
    const ctrl = new QueuesBoardSessionController(auth as never);
    await ctrl.mint({ key: 'secret-key', role: 'companion_operator' } as never, res as never);
    expect(res.cookie).toHaveBeenCalledWith(
      'openwa_bb_key',
      'secret-key',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        path: '/api/admin/queues',
        maxAge: 3600_000,
      }),
    );
  });

  it('forbids mint when canAccessOpenWaQueues is false', async () => {
    const auth = { canAccessOpenWaQueues: () => false };
    const ctrl = new QueuesBoardSessionController(auth as never);
    await expect(ctrl.mint({ key: 'x' } as never, { cookie: jest.fn() } as never)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/queue/queues-board-session.controller.spec.ts --no-coverage`  
Expected: FAIL (module/class not found)

- [ ] **Step 3: Write minimal implementation**

```typescript
// queues-board-session.constants.ts
export const QUEUES_BOARD_COOKIE_NAME = 'openwa_bb_key';
export const QUEUES_BOARD_COOKIE_PATH = '/api/admin/queues';
export const QUEUES_BOARD_COOKIE_MAX_AGE_SEC = 3600;

// queues-board-session.controller.ts
@Controller('admin/queues-board-session')
@UseGuards(ApiKeyGuard) // mirror other admin controllers
export class QueuesBoardSessionController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @HttpCode(204)
  mint(@CurrentApiKey() apiKey: ApiKey, @Res({ passthrough: true }) res: Response): void {
    if (!this.authService.canAccessOpenWaQueues(apiKey)) {
      throw new ForbiddenException('Admin or companion operator role required');
    }
    // apiKey entity stores hashed key — mint must use the raw key from the request header.
    // Prefer @Req() and read x-api-key / Bearer the same way ApiKeyGuard already validated.
  }
}
```

Implement mint by reading the raw key from the request (header already validated by guard), not from the entity hash:

```typescript
@Post()
@HttpCode(204)
mint(@Req() req: Request, @CurrentApiKey() apiKey: ApiKey, @Res({ passthrough: true }) res: Response): void {
  if (!this.authService.canAccessOpenWaQueues(apiKey)) {
    throw new ForbiddenException('Admin or companion operator role required');
  }
  const raw =
    (typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key']) ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
  if (!raw) throw new UnauthorizedException('API key required');
  const secure = process.env.NODE_ENV === 'production' || req.secure === true;
  res.cookie(QUEUES_BOARD_COOKIE_NAME, raw, {
    httpOnly: true,
    sameSite: 'strict',
    path: QUEUES_BOARD_COOKIE_PATH,
    maxAge: QUEUES_BOARD_COOKIE_MAX_AGE_SEC * 1000,
    secure,
  });
}

@Delete()
@HttpCode(204)
clear(@Res({ passthrough: true }) res: Response): void {
  res.clearCookie(QUEUES_BOARD_COOKIE_NAME, { path: QUEUES_BOARD_COOKIE_PATH });
}
```

Register `QueuesBoardSessionController` in `QueueModule` controllers array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/queue/queues-board-session.controller.spec.ts --no-coverage`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/queue/queues-board-session.constants.ts \
  src/modules/queue/queues-board-session.controller.ts \
  src/modules/queue/queues-board-session.controller.spec.ts \
  src/modules/queue/queue.module.ts
git commit -m "feat(queues): mint HttpOnly cookie for Bull Board iframe session"
```

---

### Task 2: BullBoardAuthMiddleware accepts cookie

**Files:**
- Modify: `src/common/security/bull-board-auth.middleware.ts`
- Modify: `src/common/security/bull-board-auth.middleware.spec.ts`

**Interfaces:**
- Consumes: `QUEUES_BOARD_COOKIE_NAME` from constants
- Produces: `extractKey` returns header OR cookie value (header wins if both present)

- [ ] **Step 1: Write the failing test**

```typescript
it('allows companion_operator GET authenticated via openwa_bb_key cookie', async () => {
  authService.validateApiKey.mockResolvedValue(companionKey);
  authService.canAccessOpenWaQueues.mockReturnValue(true);
  const req = reqFor('GET', {}, '/api/admin/queues/');
  req.cookies = { openwa_bb_key: 'companion-raw' };
  const next = jest.fn();
  await mw.use(req, res, next);
  expect(next).toHaveBeenCalledWith();
  expect(authService.validateApiKey).toHaveBeenCalledWith('companion-raw', expect.any(String));
});

it('does not accept cookie name outside openwa_bb_key', async () => {
  const req = reqFor('GET', {}, '/api/admin/queues/');
  req.cookies = { other: 'nope' };
  const next = jest.fn();
  await mw.use(req, res, next);
  expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
});
```

Ensure test harness parses/provides `req.cookies` (if middleware uses `cookie-parser`, mock `req.cookies` directly in unit tests).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/common/security/bull-board-auth.middleware.spec.ts -t "openwa_bb_key" --no-coverage`  
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
private extractKey(req: Request): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;

  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  const fromCookie = req.cookies?.[QUEUES_BOARD_COOKIE_NAME];
  if (typeof fromCookie === 'string' && fromCookie) return fromCookie;

  return undefined;
}
```

Confirm `cookie-parser` is already applied in `configure-app.ts` / `main.ts` before the Bull Board mount. If not, add `app.use(cookieParser())` before `mountBullBoard`.

- [ ] **Step 4: Run full middleware spec**

Run: `npx jest src/common/security/bull-board-auth.middleware.spec.ts --no-coverage`  
Expected: PASS (including companion POST still forbidden)

- [ ] **Step 5: Commit**

```bash
git add src/common/security/bull-board-auth.middleware.ts \
  src/common/security/bull-board-auth.middleware.spec.ts \
  src/configure-app.ts
git commit -m "feat(security): accept Bull Board session cookie in auth middleware"
```

---

### Task 3: Dashboard API client for mint

**Files:**
- Modify: `dashboard/src/services/api.ts`
- Create: `dashboard/src/services/queuesBoardSession.test.ts` (node:test)

**Interfaces:**
- Consumes: existing `request()` / `fetch` helper with session `X-API-Key`
- Produces: `queuesBoardSessionApi.mint(): Promise<void>`, `queuesBoardSessionApi.clear(): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
test('queuesBoardSessionApi.mint POSTs /admin/queues-board-session', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(null, { status: 204 });
  };
  const { queuesBoardSessionApi } = await import('./api.ts');
  await queuesBoardSessionApi.mint();
  assert.match(calls[0], /POST .*\/admin\/queues-board-session/);
});
```

Adapt to how `request()` builds URLs in this repo (likely `/api/admin/...`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test src/services/queuesBoardSession.test.ts`  
Expected: FAIL (export missing)

- [ ] **Step 3: Write minimal implementation**

```typescript
export const queuesBoardSessionApi = {
  mint: () => request<void>('/admin/queues-board-session', { method: 'POST' }),
  clear: () => request<void>('/admin/queues-board-session', { method: 'DELETE' }),
};
```

Ensure `request()` treats 204 as success without JSON parse.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && node --test src/services/queuesBoardSession.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/services/api.ts dashboard/src/services/queuesBoardSession.test.ts
git commit -m "feat(dashboard): API client for queues board session cookie"
```

---

### Task 4: Embed Bull Board iframe in Filas page

**Files:**
- Modify: `dashboard/src/pages/OpenWaQueues.tsx`
- Modify: `dashboard/src/pages/OpenWaQueues.css`
- Modify: `dashboard/src/pages/OpenWaQueues.test.ts`
- Modify: `dashboard/src/i18n/locales/*.json` (`filasOpenWa.embedLoading`, `filasOpenWa.embedError`)

**Interfaces:**
- Consumes: `queuesBoardSessionApi.mint`
- Produces: iframe `title` accessible, `src="/api/admin/queues"` (same-origin path; do not prefix with absolute remote host)

- [ ] **Step 1: Write the failing test**

```typescript
test('mints board session then renders iframe to /api/admin/queues', async () => {
  let minted = false;
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if ((init?.method ?? 'GET') === 'POST' && path.includes('/admin/queues-board-session')) {
      minted = true;
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 404 });
  };
  renderOpenWaQueues();
  const iframe = await rtl.screen.findByTitle(/Bull Board|Filas|Queues/i);
  assert.equal(minted, true);
  assert.match(iframe.getAttribute('src') ?? '', /\/api\/admin\/queues\/?$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test src/pages/OpenWaQueues.test.ts`  
Expected: FAIL (placeholder has no iframe)

- [ ] **Step 3: Write minimal implementation**

```tsx
export function OpenWaQueues() {
  const { t } = useTranslation();
  useDocumentTitle(t('filasOpenWa.title'));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void queuesBoardSessionApi
      .mint()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="openwa-queues-page openwa-queues-page--embed">
      <PageHeader title={t('filasOpenWa.title')} subtitle={t('filasOpenWa.subtitle')} />
      {error && <div className="error-banner" role="alert">{t('filasOpenWa.embedError')}</div>}
      {!ready && !error && <p role="status">{t('filasOpenWa.embedLoading')}</p>}
      {ready && (
        <iframe
          className="openwa-queues-board-frame"
          title={t('filasOpenWa.title')}
          src="/api/admin/queues"
        />
      )}
    </div>
  );
}
```

CSS: page uses flex column; iframe `flex: 1; width: 100%; min-height: calc(100vh - 12rem); border: 0`.

i18n (en): `"embedLoading": "Opening Bull Board…"`, `"embedError": "Could not open the queue board session"`. Mirror in all 13 locales (pt-BR required accurate; others may copy en if no translator).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && node --test src/pages/OpenWaQueues.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/pages/OpenWaQueues.tsx dashboard/src/pages/OpenWaQueues.css \
  dashboard/src/pages/OpenWaQueues.test.ts dashboard/src/i18n/locales
git commit -m "feat(dashboard): embed Bull Board iframe in Filas OpenWA"
```

---

### Task 5: Clear cookie on logout + CSP/frame sanity

**Files:**
- Modify: `dashboard/src/utils/authLifecycle.ts` (or logout path used by Layout)
- Modify: `dashboard/src/utils/authLifecycle.test.ts` if present
- Verify: `src/configure-app.ts` CSP `default-src 'self'` allows same-origin iframe (no change if already true)

**Interfaces:**
- Consumes: `queuesBoardSessionApi.clear`
- Produces: logout best-effort clears board cookie (ignore network errors)

- [ ] **Step 1: Write failing test** that logout invokes DELETE queues-board-session (spy fetch)

- [ ] **Step 2: Run to fail**

- [ ] **Step 3: Wire `clear()` into existing logout/clear-session helper**

- [ ] **Step 4: Run authLifecycle + OpenWaQueues tests PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(auth): clear Bull Board session cookie on logout"
```

---

### Task 6: Verification smoke + docs

**Files:**
- Modify: `docs/superpowers/plans/2026-09-12-filas-bull-board-embed.md` checkboxes as done during execution
- Optional changelog note under Unreleased if repo requires

- [ ] **Step 1: Run focused backend suite**

Run: `npx jest src/common/security/bull-board-auth.middleware.spec.ts src/modules/queue/queues-board-session.controller.spec.ts --no-coverage`  
Expected: PASS

- [ ] **Step 2: Run focused dashboard suite**

Run: `cd dashboard && node --test src/pages/OpenWaQueues.test.ts src/services/queuesBoardSession.test.ts`  
Expected: PASS

- [ ] **Step 3: Manual smoke checklist**

1. Login admin → Filas → iframe mostra Bull Board (lista de filas/jobs).
2. Login companion_operator → Filas → board visível; retry/remove retorna 403.
3. Abrir DevTools → Network: nenhum `?apiKey=`; cookie `openwa_bb_key` Path `/api/admin/queues`.
4. Logout → cookie limpo; reabrir `/api/admin/queues` em aba → 401.

- [ ] **Step 4: Commit verification notes if any code tweaks**

```bash
git commit -m "test(filas): verify Bull Board embed auth path"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Iframe same-origin `/api/admin/queues` | Task 4 |
| Cookie bridge mint with session X-API-Key | Task 1 + 3 |
| Middleware reads cookie; no `?apiKey` | Task 2 |
| companion_operator read-only | Task 2 (existing middleware + regression) |
| Main-content only; keep shell | Task 4 |
| Clear on logout | Task 5 |
| Focused verification | Task 6 |

## Placeholder scan

No TBD/TODO left in task steps; cookie name, paths, and code sketches are concrete.

## Type consistency

- Cookie name `openwa_bb_key` / path `/api/admin/queues` shared via constants across Tasks 1–2.
- Client path `/admin/queues-board-session` matches controller `@Controller('admin/queues-board-session')` under global `/api` prefix.
- Iframe `src="/api/admin/queues"` matches `BULL_BOARD_BASE_PATH`.
