"""Test helpers — an httpx.MockTransport-based recorder.

Tests assert on exact method/url/body/headers without any real network or
global monkey-patching. ``httpx.MockTransport`` is the idiomatic, native way
to test an httpx-based client.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx


@dataclass
class RecordedCall:
    method: str
    url: str
    headers: dict[str, str]
    body: Any


@dataclass
class MockBackend:
    """A scripted backend. Raises if a call doesn't match a route."""
    calls: list[RecordedCall] = field(default_factory=list)
    routes: list[tuple[str, str, Callable[[RecordedCall], httpx.Response]]] = field(default_factory=list)
    fallback: Callable[[RecordedCall], httpx.Response] | None = None

    def on(
        self,
        method: str,
        path_prefix: str,
        status: int = 200,
        body: Any = None,
    ) -> "MockBackend":
        def responder(_: RecordedCall) -> httpx.Response:
            if status in (204, 100, 304) or body is None:
                return httpx.Response(status, content=b"")
            return httpx.Response(status, content=json.dumps(body).encode(), headers={"content-type": "application/json"})

        self.routes.append((method.upper(), path_prefix, responder))
        return self

    def as_transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            method = request.method.upper()
            url = str(request.url)
            body: Any = None
            if request.content:
                try:
                    body = json.loads(request.content)
                except ValueError:
                    body = request.content.decode(errors="replace")
            call = RecordedCall(method=method, url=url, headers=dict(request.headers), body=body)
            self.calls.append(call)

            # Most-specific (longest) matching prefix wins, so a nested route like
            # "/catalog/products" is preferred over "/catalog" regardless of
            # registration order.
            matches = [(pp, resp) for m, pp, resp in self.routes if m == method and pp in url]
            if matches:
                _, responder = max(matches, key=lambda pair: len(pair[0]))
                return responder(call)
            if self.fallback is not None:
                return self.fallback(call)
            raise AssertionError(f"MockBackend: no route for {method} {url}")

        return httpx.MockTransport(handler)

    @property
    def last_call(self) -> RecordedCall:
        return self.calls[-1]


def make_client(backend: MockBackend, base_url: str = "http://localhost:2785", api_key: str = "owa_k1_test"):
    from openwa import OpenWAClient

    return OpenWAClient(base_url=base_url, api_key=api_key, transport=backend.as_transport())
