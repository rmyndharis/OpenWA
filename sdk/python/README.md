# rmyndharis-openwa

Official Python SDK for [OpenWA](https://github.com/rmyndharis/OpenWA), the open-source WhatsApp API Gateway. OpenWA is an independent project, not affiliated with or endorsed by WhatsApp or Meta.

A synchronous client built on [httpx](https://www.python-httpx.org/), with bundled type hints (PEP 561).

## Install

```bash
pip install rmyndharis-openwa
```

Requires Python 3.9+. The importable module is `openwa`.

## Usage

```python
from openwa import OpenWAClient

client = OpenWAClient(
    base_url="https://your-gateway.example.com",
    api_key="owa_k1_…",
)

# Sessions are addressed by the UUID that create() returns, not by name. Create a session once;
# afterwards, find its id with client.sessions.list({"name": "my-session"}).
session = client.sessions.create({"name": "my-session"})
client.sessions.start(session["id"])

result = client.messages.send_text(session["id"], {
    "chatId": "628123456789@c.us",
    "text": "Hello from the OpenWA Python SDK!",
})
print(result["messageId"])
```

The client is also a context manager (it closes the underlying connection pool on exit):

```python
with OpenWAClient(base_url="…", api_key="…") as client:
    client.messages.send_text(session_id, {"chatId": "…@c.us", "text": "hi"})
```

For tests, pass an httpx transport — no global monkey-patching required:

```python
import httpx
client = OpenWAClient(base_url="…", api_key="…", transport=httpx.MockTransport(handler))
```

## Search

`GET /search` is wrapped as `client.search.search(params)`. Only `q` is required;
the rest (`sessionId`, `chatId`, `direction`, `type`, `from`, `dateFrom`,
`dateTo`, `limit`, `offset`) are optional. `dateFrom` / `dateTo` are epoch-ms.
The active search provider (built-in DB full-text, or a plugin) answers; if none
is configured the server returns 501.

```python
res = client.search.search({"q": "invoice", "sessionId": session_id, "limit": 20})
for hit in res["hits"]:
    print(hit["snippet"], hit["score"])
```

## Messaging

> Voice notes: pass `ptt=True` inside the body dict to `send_audio` to send a real WhatsApp voice note (PTT). Supply `audio/ogg; codecs=opus` audio for reliable playback; the server defaults the mimetype to that when `ptt` is set without one.

## Errors

A non-2xx response raises a typed `OpenWAApiError` subclass — `OpenWAAuthError` (401),
`OpenWAForbiddenError` (403), `OpenWANotFoundError` (404), `OpenWAConflictError` (409),
`OpenWARateLimitError` (429), `OpenWANotImplementedError` (501),
`OpenWAServiceUnavailableError` (503) — each carrying `.status` and the parsed `.body`. A
timeout raises `OpenWATimeoutError`. 503 is transient, but a catalog 503 can persist because
WhatsApp may never answer that query, so bound any retry. A 429 from the global rate limiter
lifts when its window expires (seconds for the per-second tier, up to an hour for the hourly
tier by default), and `.retry_after_seconds` carries its `Retry-After` header. A 429 whose
`.code` is `"SEND_PACING_LIMITED"` is not transient: do not retry it before
`.retry_after_seconds`, which then comes from the body and can be hours. Every API error also
exposes the response `.headers`. In a routed deployment only 503 proves the request was never
carried out: a forward that fails after the request reached the owner node answers 502 or 504.

```python
from openwa import OpenWANotFoundError

try:
    client.sessions.get("00000000-0000-0000-0000-000000000000")
except OpenWANotFoundError as e:
    print(e.status)  # 404
```

## Notes

- **Use HTTPS in production** — the API key is sent as `X-API-Key` and is bearer-equivalent.
- The SDK does **not** retry, and **never follows redirects** (so the key is never re-sent to
  a redirect target). Path segments are percent-encoded; a base-URL path prefix (e.g. behind a
  reverse proxy) is preserved.
- Escape hatch for endpoints the SDK does not wrap:
  `client.request(method, path, query=…, body=…)`.

## Releasing

Publishing to PyPI is done by the
[`python-sdk-release.yml`](../../.github/workflows/python-sdk-release.yml)
workflow, which authenticates with **PyPI Trusted Publishing (OIDC)**. There is
no PyPI token in the workflow or in the repository secrets: PyPI mints a
short-lived credential from the GitHub OIDC token, so nothing long-lived exists
to leak or rotate.

One-time setup, required **before** the first tag — on pypi.org, open the
project's publishing settings and add a GitHub trusted publisher:

- Owner: `rmyndharis`
- Repository: `OpenWA`
- Workflow name: `python-sdk-release.yml`

There are no repository secrets to add. Until the trusted publisher exists PyPI
rejects the upload, so configure it first.

Cutting a release:

1. Bump `version` in `pyproject.toml` and land it on `main`.
2. Tag that commit `py-sdk-v<version>` (e.g. `py-sdk-v0.5.0`) and push the tag.
   The SDK has its own version line — the monorepo's `v*` tags are the app
   version and never trigger an SDK publish.
3. The workflow re-runs the test suite, builds the sdist and wheel, and
   uploads. The artifacts published are the ones those tests passed against.

## License

MIT
