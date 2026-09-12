# Filas OpenWA Opção A (sessão / mesma instância) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tela Filas OpenWA monitora só a mesma instância OpenWA, autenticada com a API key da sessão do usuário (`X-API-Key`), sem `REMOTE_OPENWA_*` e sem mutações Bull Board para companion.

**Architecture:** Substituir o BFF remoto (`RemoteOpenWaQueuesService` + fetch HTTP com secret de env) por um serviço local que lê profundidades BullMQ (`webhook-queue` + `ingress-queue`) via `@InjectQueue` opcional, no mesmo padrão de `InfraStatusController`. Endpoint `GET /api/admin/openwa-queues` gated por `canAccessOpenWaQueues` (admin | companion_operator) usando a key do request. Frontend continua com `request()` + sessão; i18n deixa de falar em remoto.

**Tech Stack:** NestJS, BullMQ, Jest, React dashboard (`request` + TanStack Query), i18n JSON locales.

**Spec:** Decisão CTO/usuário Opção A (2026-09-12): mesma instância; auth sessão; sem login em `/api/admin/queues`; companion allowlist read-only; remover BFF remoto default.

## Global Constraints

- Auth = API key já logada (`X-API-Key` da sessão); nunca `REMOTE_OPENWA_ADMIN_API_KEY`.
- Não criar tela de login em `/api/admin/queues`.
- `companion_operator` permanece na allowlist Filas; superfície GET-only (sem mutações admin Bull Board).
- Seguir padrões existentes (`@RequireRole`, `@RequireUnscopedKey`, `PageHeader`, loading/erro/vazio).
- Remover `REMOTE_OPENWA_*` do caminho default (preferência A-only: remover BFF remoto).
- TDD: teste falha → implementação mínima → verde → commit.
- Branch: `feat/filas-openwa-session-auth` a partir de `main`.

---

## File map

| File | Responsibility |
|------|----------------|
| `src/modules/infra/openwa-queues.service.ts` | Lê contagens locais BullMQ; retorna status |
| `src/modules/infra/openwa-queues.controller.ts` | `GET admin/openwa-queues` + gate role |
| `src/modules/infra/dto/openwa-queues.dto.ts` | DTO Swagger do status local |
| `src/modules/infra/infra.module.ts` | Registra controller/service novos; remove remotos |
| `src/modules/auth/auth.service.ts` | `canAccessOpenWaQueues` (rename) |
| `src/config/configuration.ts` + `env.validation.ts` | Remover bloco `remoteOpenWa` / validação REMOTE_* |
| `.env.example` | Remover comentários REMOTE_OPENWA_* |
| `dashboard/src/services/api.ts` | Cliente `/admin/openwa-queues` |
| `dashboard/src/hooks/queries.ts` | Query key + hook renomeados |
| `dashboard/src/pages/OpenWaQueues.tsx` + test + i18n | UI same-host copy |
| Delete `remote-openwa-queues.*` | Remoção do BFF remoto |

---

### Task 1: Auth helper rename `canAccessOpenWaQueues`

**Files:**
- Modify: `src/modules/auth/auth.service.ts` (method near `canAccessOpenWaRemoteQueues`)
- Modify: `src/modules/auth/auth.service.spec.ts` (describe/it that calls the helper)

**Interfaces:**
- Consumes: `ApiKey` with `role: ApiKeyRole`
- Produces: `canAccessOpenWaQueues(apiKey: ApiKey): boolean` — true iff ADMIN or COMPANION_OPERATOR

- [ ] **Step 1: Write the failing test**

In `auth.service.spec.ts`, replace the remote-queues helper block with:

```typescript
it('allows admin and companion_operator on OpenWA queues helper', () => {
  expect(service.canAccessOpenWaQueues({ role: ApiKeyRole.ADMIN } as ApiKey)).toBe(true);
  expect(
    service.canAccessOpenWaQueues({ role: ApiKeyRole.COMPANION_OPERATOR } as ApiKey),
  ).toBe(true);
  expect(service.canAccessOpenWaQueues({ role: ApiKeyRole.OPERATOR } as ApiKey)).toBe(false);
  expect(service.canAccessOpenWaQueues({ role: ApiKeyRole.VIEWER } as ApiKey)).toBe(false);
});
```

Remove any remaining references to `canAccessOpenWaRemoteQueues` in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/auth/auth.service.spec.ts -t "OpenWA queues helper" --no-coverage`

Expected: FAIL — `canAccessOpenWaQueues is not a function` (or property undefined).

- [ ] **Step 3: Write minimal implementation**

In `auth.service.ts`, rename:

```typescript
canAccessOpenWaQueues(apiKey: ApiKey): boolean {
  return apiKey.role === ApiKeyRole.ADMIN || apiKey.role === ApiKeyRole.COMPANION_OPERATOR;
}
```

Delete `canAccessOpenWaRemoteQueues`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/auth/auth.service.spec.ts -t "OpenWA queues helper" --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts
git commit -m "refactor(auth): rename canAccessOpenWaQueues for same-instance Filas"
```

---

### Task 2: Local OpenWaQueuesService (BullMQ depths)

**Files:**
- Create: `src/modules/infra/openwa-queues.service.ts`
- Create: `src/modules/infra/openwa-queues.service.spec.ts`
- Create: `src/modules/infra/dto/openwa-queues.dto.ts`

**Interfaces:**
- Consumes: optional `Queue` for `QUEUE_NAMES.WEBHOOK` and `QUEUE_NAMES.INGRESS`; `ConfigService` key `queue.enabled`
- Produces:

```typescript
export type OpenWaQueueDepth = { pending: number; completed: number; failed: number };
export type OpenWaQueuesStatus = {
  configured: boolean;
  source: 'local' | 'unconfigured';
  queues: Array<{ name: string; counts: OpenWaQueueDepth }>;
};
// OpenWaQueuesService.getStatus(): Promise<OpenWaQueuesStatus>
```

- [ ] **Step 1: Write the failing test**

Create `openwa-queues.service.spec.ts`:

```typescript
import { OpenWaQueuesService } from './openwa-queues.service';
import { QUEUE_NAMES } from '../queue/queue-names';

describe('OpenWaQueuesService', () => {
  function config(enabled: boolean) {
    return { get: (key: string, def?: unknown) => (key === 'queue.enabled' ? enabled : def) };
  }

  it('returns unconfigured when queue disabled', async () => {
    const svc = new OpenWaQueuesService(config(false) as never, undefined, undefined);
    await expect(svc.getStatus()).resolves.toEqual({
      configured: false,
      source: 'unconfigured',
      queues: [],
    });
  });

  it('maps local BullMQ job counts for webhook and ingress', async () => {
    const webhook = {
      getJobCounts: jest.fn().mockResolvedValue({
        wait: 1,
        active: 2,
        delayed: 0,
        completed: 10,
        failed: 3,
      }),
    };
    const ingress = {
      getJobCounts: jest.fn().mockResolvedValue({
        wait: 0,
        active: 1,
        delayed: 1,
        completed: 5,
        failed: 0,
      }),
    };
    const svc = new OpenWaQueuesService(config(true) as never, webhook as never, ingress as never);
    const result = await svc.getStatus();
    expect(webhook.getJobCounts).toHaveBeenCalledWith('wait', 'active', 'delayed', 'completed', 'failed');
    expect(result).toEqual({
      configured: true,
      source: 'local',
      queues: [
        { name: QUEUE_NAMES.WEBHOOK, counts: { pending: 3, completed: 10, failed: 3 } },
        { name: QUEUE_NAMES.INGRESS, counts: { pending: 2, completed: 5, failed: 0 } },
      ],
    });
  });

  it('degrades missing queue injection to zero counts when enabled', async () => {
    const svc = new OpenWaQueuesService(config(true) as never, undefined, undefined);
    await expect(svc.getStatus()).resolves.toEqual({
      configured: true,
      source: 'local',
      queues: [
        { name: QUEUE_NAMES.WEBHOOK, counts: { pending: 0, completed: 0, failed: 0 } },
        { name: QUEUE_NAMES.INGRESS, counts: { pending: 0, completed: 0, failed: 0 } },
      ],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/infra/openwa-queues.service.spec.ts --no-coverage`

Expected: FAIL — cannot find module `./openwa-queues.service`

- [ ] **Step 3: Write minimal implementation**

`openwa-queues.service.ts`:

```typescript
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue-names';
import { createLogger } from '../../common/services/logger.service';

export type OpenWaQueueDepth = { pending: number; completed: number; failed: number };
export type OpenWaQueuesStatus = {
  configured: boolean;
  source: 'local' | 'unconfigured';
  queues: Array<{ name: string; counts: OpenWaQueueDepth }>;
};

@Injectable()
export class OpenWaQueuesService {
  private readonly logger = createLogger('OpenWaQueuesService');

  constructor(
    private readonly config: ConfigService,
    @Optional() @InjectQueue(QUEUE_NAMES.WEBHOOK) private readonly webhookQueue?: Queue,
    @Optional() @InjectQueue(QUEUE_NAMES.INGRESS) private readonly ingressQueue?: Queue,
  ) {}

  async getStatus(): Promise<OpenWaQueuesStatus> {
    const enabled = this.config.get<boolean>('queue.enabled', false);
    if (!enabled) {
      return { configured: false, source: 'unconfigured', queues: [] };
    }
    return {
      configured: true,
      source: 'local',
      queues: [
        { name: QUEUE_NAMES.WEBHOOK, counts: await this.readCounts(this.webhookQueue) },
        { name: QUEUE_NAMES.INGRESS, counts: await this.readCounts(this.ingressQueue) },
      ],
    };
  }

  private async readCounts(queue?: Queue): Promise<OpenWaQueueDepth> {
    if (!queue) return { pending: 0, completed: 0, failed: 0 };
    try {
      const c = await queue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
      return {
        pending: (c.wait ?? 0) + (c.active ?? 0) + (c.delayed ?? 0),
        completed: c.completed ?? 0,
        failed: c.failed ?? 0,
      };
    } catch (error) {
      this.logger.warn('Failed to read queue job counts', { error: String(error) });
      return { pending: 0, completed: 0, failed: 0 };
    }
  }
}
```

DTO `openwa-queues.dto.ts` mirroring types with Swagger (`source` enum `local` | `unconfigured`; descriptions say same-instance).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/infra/openwa-queues.service.spec.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/infra/openwa-queues.service.ts src/modules/infra/openwa-queues.service.spec.ts src/modules/infra/dto/openwa-queues.dto.ts
git commit -m "feat(infra): read local BullMQ depths for Filas OpenWA"
```

---

### Task 3: Controller + module wiring; remove remote BFF

**Files:**
- Create: `src/modules/infra/openwa-queues.controller.ts`
- Create: `src/modules/infra/openwa-queues.controller.spec.ts`
- Modify: `src/modules/infra/infra.module.ts`
- Delete: `remote-openwa-queues.controller.ts`, `.service.ts`, their specs, `dto/remote-openwa-queues.dto.ts`

**Interfaces:**
- Consumes: `OpenWaQueuesService.getStatus()`, `AuthService.canAccessOpenWaQueues(apiKey)`
- Produces: `GET /api/admin/openwa-queues` (Nest `@Controller('admin/openwa-queues')`) — ForbiddenException if helper false

- [ ] **Step 1: Write the failing test**

```typescript
import { ForbiddenException } from '@nestjs/common';
import { OpenWaQueuesController } from './openwa-queues.controller';

describe('OpenWaQueuesController', () => {
  it('forbids keys without queues access', async () => {
    const auth = { canAccessOpenWaQueues: jest.fn().mockReturnValue(false) };
    const queues = { getStatus: jest.fn() };
    const ctrl = new OpenWaQueuesController(queues as never, auth as never);
    await expect(ctrl.getStatus({ role: 'viewer' } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(queues.getStatus).not.toHaveBeenCalled();
  });

  it('returns local status for allowed roles', async () => {
    const auth = { canAccessOpenWaQueues: jest.fn().mockReturnValue(true) };
    const payload = { configured: true, source: 'local', queues: [] };
    const queues = { getStatus: jest.fn().mockResolvedValue(payload) };
    const ctrl = new OpenWaQueuesController(queues as never, auth as never);
    await expect(ctrl.getStatus({ role: 'companion_operator' } as never)).resolves.toEqual(payload);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/infra/openwa-queues.controller.spec.ts --no-coverage`

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Controller mirrors previous remote one but:

- path `admin/openwa-queues`
- `canAccessOpenWaQueues`
- injects `OpenWaQueuesService`
- summary: "Same-instance OpenWA queue depths (session API key)"

Update `infra.module.ts` providers/controllers accordingly. Delete all `remote-openwa-queues*` files.

- [ ] **Step 4: Run tests**

Run: `npx jest src/modules/infra/openwa-queues.controller.spec.ts src/modules/infra/openwa-queues.service.spec.ts --no-coverage`

Expected: PASS. Grep repo for `RemoteOpenWaQueues` / `openwa-remote-queues` in `src/` — zero hits.

- [ ] **Step 5: Commit**

```bash
git add -A src/modules/infra/
git commit -m "feat(infra): expose GET /admin/openwa-queues; drop remote BFF"
```

---

### Task 4: Remove REMOTE_OPENWA_* config

**Files:**
- Modify: `src/config/configuration.ts` (remove `remoteOpenWa` block)
- Modify: `src/config/env.validation.ts` (remove REMOTE_* validation block)
- Modify: `src/config/env.validation.spec.ts` (remove REMOTE_* tests)
- Modify: `.env.example` (remove Remote OpenWA comment block)

- [ ] **Step 1: Write the failing test adjustment**

Replace REMOTE_OPENWA specs with a negative check that unused keys are ignored (or simply delete the three REMOTE tests). Add:

```typescript
it('does not require REMOTE_OPENWA_* (Filas Opção A is same-instance)', () => {
  expect(() =>
    validateEnv({
      REMOTE_OPENWA_BASE_URL: 'https://openwa.insightsmt.com.br',
      REMOTE_OPENWA_ADMIN_API_KEY: 'orphan-key',
    }),
  ).not.toThrow();
});
```

(Optional orphan keys must not fail validation after removal of the pair check.)

- [ ] **Step 2: Run to see current behavior**

Run: `npx jest src/config/env.validation.spec.ts -t "REMOTE_OPENWA|same-instance" --no-coverage`

Expected: old pair tests may still pass; new test may fail if pair validation still throws — or after deleting old tests, new test fails until validation block removed.

- [ ] **Step 3: Remove config + validation + .env.example**

Delete `remoteOpenWa` from `configuration.ts`. Delete the `remoteBase`/`remoteKey` block in `env.validation.ts`. Delete REMOTE comment block in `.env.example`. Delete obsolete REMOTE_* positive/negative tests; keep the “does not require” test.

- [ ] **Step 4: Run tests**

Run: `npx jest src/config/env.validation.spec.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/configuration.ts src/config/env.validation.ts src/config/env.validation.spec.ts .env.example
git commit -m "chore(config): remove unused REMOTE_OPENWA_* for Filas Opção A"
```

---

### Task 5: Dashboard client + page + i18n (same instance)

**Files:**
- Modify: `dashboard/src/services/api.ts` (`OpenWaQueuesStatus`, `openWaQueuesApi.getStatus` → `/admin/openwa-queues`)
- Modify: `dashboard/src/hooks/queries.ts` (key `openWaQueues`, hook `useOpenWaQueuesQuery`)
- Modify: `dashboard/src/pages/OpenWaQueues.tsx` (hook + source label for `local`)
- Modify: `dashboard/src/pages/OpenWaQueues.test.ts` (stub path `/api/admin/openwa-queues`)
- Modify: all `dashboard/src/i18n/locales/*.json` `filasOpenWa` strings (subtitle/loadError/unconfigured*/empty*/source*)

**Interfaces:**
- Consumes: `GET /api/admin/openwa-queues` via existing `request()`
- Produces: same UI states; `source === 'local'` shows local source string; unconfigured = queues disabled locally

- [ ] **Step 1: Write the failing test**

Update smoke test stub URL and type:

```typescript
const LOCAL_QUEUES: OpenWaQueuesStatus = {
  configured: true,
  source: 'local',
  queues: [{ name: 'webhook-queue', counts: { pending: 1, completed: 2, failed: 0 } }],
};
// path === '/api/admin/openwa-queues'
```

Rename import type to `OpenWaQueuesStatus`.

- [ ] **Step 2: Run dashboard test to verify fail/mismatch**

Run: `npm --prefix dashboard test -- src/pages/OpenWaQueues.test.ts` (or project’s dashboard test script)

Expected: FAIL until client path + types updated (or stub 404).

- [ ] **Step 3: Implement client + UI + i18n**

- `source: 'local' | 'unconfigured'`
- Hook rename `useOpenWaQueuesQuery`
- Page: `data.source === 'local' ? t('filasOpenWa.sourceLocal') : …` (drop bull-board/infra-status branches)
- i18n pt-BR examples:
  - subtitle: "Estado das filas nesta instância OpenWA"
  - loadError: "Não foi possível carregar as filas"
  - unconfigured: "Filas desabilitadas neste servidor"
  - unconfiguredHint: "Defina QUEUE_ENABLED=true (e Redis) para monitorar as filas locais"
  - empty description: "Nenhuma profundidade de fila disponível no momento"
  - sourceLocal: "Fonte: filas locais (BullMQ)"
- Mirror meaning in en + other locales (same keys; no REMOTE_* mentions)

- [ ] **Step 4: Run tests**

Run dashboard OpenWaQueues test + grep `openwa-remote-queues` / `REMOTE_OPENWA` in `dashboard/` — zero hits.

- [ ] **Step 5: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): Filas OpenWA consume same-instance session endpoint"
```

---

### Task 6: Verification + PR

**Files:** none new (verification + git/gh)

- [ ] **Step 1: Focused Jest**

```bash
npx jest src/modules/auth/auth.service.spec.ts src/modules/infra/openwa-queues.service.spec.ts src/modules/infra/openwa-queues.controller.spec.ts src/config/env.validation.spec.ts --no-coverage
```

Expected: PASS

- [ ] **Step 2: Dashboard test + typecheck/lint as available**

```bash
npm --prefix dashboard test -- --test-path-pattern=OpenWaQueues
# plus repo scripts if present:
npm run lint
npm run typecheck
```

Fix failures before claiming done.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin HEAD
gh pr create --repo christyan371/OpenWA --base main --title "feat: Filas OpenWA mesma instância (Opção A)" --body "..."
```

Do **not** merge.

- [ ] **Step 4: Linear**

Comment/update INS-166 (and related Done issues) describing pivot Opção A; create issue for pivot if useful; set status In Progress/Done as accurate.

---

## Self-review

1. **Spec coverage:** same-instance ✓; session API key ✓; no REMOTE default ✓; no `/api/admin/queues` login ✓; companion allowlist read-only ✓; remove remote BFF ✓; i18n/docs/.env ✓.
2. **Placeholders:** none.
3. **Types:** `OpenWaQueuesStatus.source` is `'local' | 'unconfigured'` consistently backend ↔ frontend.
