# rmyndharis-openwa

Official Python SDK for the [OpenWA](https://github.com/rmyndharis/OpenWA) WhatsApp API Gateway.

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

client.sessions.start("my-session")

result = client.messages.send_text("my-session", {
    "chatId": "628123456789@c.us",
    "text": "Hello from the OpenWA Python SDK!",
})
print(result["messageId"])
```

The client is also a context manager (it closes the underlying connection pool on exit):

```python
with OpenWAClient(base_url="…", api_key="…") as client:
    client.messages.send_text("my-session", {"chatId": "…@c.us", "text": "hi"})
```

For tests, pass an httpx transport — no global monkey-patching required:

```python
import httpx
client = OpenWAClient(base_url="…", api_key="…", transport=httpx.MockTransport(handler))
```

## Messaging

> Voice notes: pass `ptt=True` inside the body dict to `send_audio` to send a real WhatsApp voice note (PTT). Supply `audio/ogg; codecs=opus` audio for reliable playback; the server defaults the mimetype to that when `ptt` is set without one.

## Errors

A non-2xx response raises a typed `OpenWAApiError` subclass — `OpenWAAuthError` (401),
`OpenWAForbiddenError` (403), `OpenWANotFoundError` (404), `OpenWAConflictError` (409),
`OpenWARateLimitError` (429), `OpenWANotImplementedError` (501) — each carrying `.status`
and the parsed `.body`. A timeout raises `OpenWATimeoutError`.

```python
from openwa import OpenWANotFoundError

try:
    client.sessions.get("missing")
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

## License

MIT
