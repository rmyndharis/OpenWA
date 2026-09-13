# Filas OpenWA — Bull Board embed (design)

**Date:** 2026-09-12  
**Status:** Approved for planning (CTO pivot; replaces counter/JSON UI)  
**Related:** cleanup branch `fix/filas-bull-board-embed-prep`; prior PRs #1–#3

## Problem

O menu **Filas OpenWA** precisa mostrar o **Bull Board real** (lista/jobs/ações UI) em `/api/admin/queues`, embutido no `main-content` do dashboard — não cards de contadores nem `GET .../api/queues` mapeado para UI custom.

`BullBoardAuthMiddleware` exige `X-API-Key` / Bearer. Navegação de documento (iframe `src`) **não** envia esse header. `?apiKey` na URL é proibido (já removido do middleware).

## Approaches

| # | Approach | Pros | Cons |
|---|----------|------|------|
| A | **Iframe same-origin + cookie bridge** | Reusa mount Express existente; assets/API relativos do board funcionam; `companion_operator` GET/HEAD já no middleware | Precisa mint de cookie HttpOnly + `extractKey` cookie |
| B | Proxy Nest que injeta `X-API-Key` | Sem cookie no browser | Reescrever paths/basePath; proxy de assets + XHR; mais superfície |
| C | Reimplementar UI Bull Board em React | Controle total DS | Fora do pedido; reinventa o board |

**Escolha: A.**

## Design

1. **Mint:** `POST /api/admin/queues-board-session` (Nest, `ApiKeyGuard` + `canAccessOpenWaQueues`) seta cookie HttpOnly `Secure` `SameSite=Strict` `Path=/api/admin/queues` com a API key validada (ou token opaco equivalente), TTL curto (ex. 1h). Sem key no query string.
2. **Auth board:** `BullBoardAuthMiddleware.extractKey` também lê o cookie (só sob o mount `/api/admin/queues`). ADMIN mutate; `companion_operator` GET/HEAD only (já implementado).
3. **Dashboard:** rota `/filas-openwa` — `PageHeader` + iframe `src="/api/admin/queues"` full width/height do main-content. Antes do load: `POST` mint via `request()` (já manda `X-API-Key` da sessão).
4. **CSP:** `default-src 'self'` já permite iframe same-origin; helmet `frameguard` default SAMEORIGIN ok. Confirmar `frame-src` se CSP for apertada depois.
5. **Non-goals:** redesign do shell; BFF remoto; `REMOTE_OPENWA_*`; cards de profundidade.

## Success

Admin e `companion_operator` abrem Filas e veem Bull Board real dentro do layout; companion não muta; sem `?apiKey` na URL.
