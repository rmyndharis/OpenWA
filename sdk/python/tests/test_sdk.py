"""Unit tests for the OpenWA Python SDK — assert exact paths and bodies."""

from __future__ import annotations

import pytest

from openwa import OpenWAClient, OpenWAApiError, OpenWANotFoundError

from conftest import MockBackend, make_client


# ── Client core ────────────────────────────────────────────────────


class TestClientCore:
    def test_requires_base_url_and_api_key(self):
        with pytest.raises(ValueError):
            OpenWAClient(base_url="", api_key="k")
        with pytest.raises(ValueError):
            OpenWAClient(base_url="http://x", api_key="")

    def test_sends_api_key_header(self):
        backend = MockBackend().on("GET", "/api/sessions", body=[])
        client = make_client(backend)
        client.sessions.list()
        assert backend.last_call.headers["x-api-key"] == "owa_k1_test"
        assert backend.last_call.headers["content-type"] == "application/json"

    def test_default_headers_cannot_override_api_key(self):
        # A caller-supplied default header must NEVER clobber the auth/JSON headers.
        backend = MockBackend().on("GET", "/api/sessions", body=[])
        client = OpenWAClient(
            base_url="http://x",
            api_key="REAL_KEY",
            default_headers={"X-API-Key": "EVIL", "Content-Type": "text/plain", "X-Trace": "keep"},
            transport=backend.as_transport(),
        )
        client.sessions.list()
        assert backend.last_call.headers["x-api-key"] == "REAL_KEY"
        assert backend.last_call.headers["content-type"] == "application/json"
        assert backend.last_call.headers["x-trace"] == "keep"  # benign custom headers still pass through

    def test_non_json_2xx_body_returns_text(self):
        import httpx

        def handler(_req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"plain text", headers={"content-type": "text/plain"})

        client = OpenWAClient(base_url="http://x", api_key="k", transport=httpx.MockTransport(handler))
        # A non-JSON 2xx body must surface as text, not raise a raw JSONDecodeError.
        assert client.sessions.list() == "plain text"

    def test_path_segments_are_encoded(self):
        backend = MockBackend().on("GET", "/history", body=[])
        make_client(backend).messages.history("s", "weird/id#x")
        assert "weird%2Fid%23x" in backend.last_call.url
        backend2 = MockBackend().on("GET", "/history", body=[])
        make_client(backend2).messages.history("s", "a@c.us")
        assert "/messages/a@c.us/history" in backend2.last_call.url  # @ preserved

    def test_raw_request_escape_hatch(self):
        backend = MockBackend().on("GET", "/api/anything", body={"ok": True})
        result = make_client(backend).request("GET", "/api/anything", query={"a": 1})
        assert result == {"ok": True}
        assert "a=1" in backend.last_call.url

    def test_treats_unfollowed_redirect_as_error(self):
        import httpx

        calls: list[httpx.URL] = []

        def handler(req: httpx.Request) -> httpx.Response:
            calls.append(req.url)
            return httpx.Response(
                302,
                headers={"location": "http://evil.example/x", "content-type": "application/json"},
                content=b'{"redirected": true}',
            )

        client = OpenWAClient(base_url="http://x", api_key="k", transport=httpx.MockTransport(handler))
        # A redirect is NOT followed (which would re-send X-API-Key to the target). An unfollowed 3xx
        # is not a usable response, so it surfaces as an API error — matching the JS transport.
        with pytest.raises(OpenWAApiError):
            client.sessions.list()
        assert len(calls) == 1  # the redirect target was never requested

    def test_strips_trailing_slash(self):
        backend = MockBackend().on("GET", "/api/sessions", body=[])
        client = OpenWAClient(base_url="http://localhost:2785/", api_key="k", transport=backend.as_transport())
        client.sessions.list()
        assert backend.last_call.url == "http://localhost:2785/api/sessions"

    def test_query_params_skip_none(self):
        backend = MockBackend().on("GET", "/messages", body=[])
        make_client(backend).messages.list("s1", {"chatId": "a@c.us", "limit": 10})
        url = backend.last_call.url
        assert "chatId=a%40c.us" in url
        assert "limit=10" in url

    def test_204_is_none(self):
        backend = MockBackend().on("DELETE", "/api/sessions", status=204)
        assert make_client(backend).sessions.delete("x") is None

    def test_404_maps_to_not_found_error(self):
        backend = MockBackend().on("GET", "/api/sessions/missing", status=404, body={
            "statusCode": 404, "message": "Session not found", "error": "Not Found"
        })
        with pytest.raises(OpenWANotFoundError):
            make_client(backend).sessions.get("missing")

    def test_exposes_all_resources(self):
        client = make_client(MockBackend())
        for r in ["sessions", "messages", "contacts", "groups", "webhooks", "chats", "status", "health"]:
            assert hasattr(client, r)


# ── Messages (the critical send-text fix) ──────────────────────────


class TestMessages:
    def test_send_text_uses_send_text_path(self):
        backend = MockBackend().on("POST", "/send-text", body={"messageId": "m1", "timestamp": 1})
        make_client(backend).messages.send_text("s1", {"chatId": "a@c.us", "text": "hi"})
        assert backend.last_call.url == "http://localhost:2785/api/sessions/s1/messages/send-text"
        assert backend.last_call.body == {"chatId": "a@c.us", "text": "hi"}

    @pytest.mark.parametrize("method,segment", [
        ("send_image", "send-image"),
        ("send_video", "send-video"),
        ("send_audio", "send-audio"),
        ("send_document", "send-document"),
        ("send_sticker", "send-sticker"),
    ])
    def test_media_segments(self, method, segment):
        backend = MockBackend().on("POST", f"/{segment}", body={"messageId": "m", "timestamp": 2})
        fn = getattr(make_client(backend).messages, method)
        fn("s", {"chatId": "a@c.us", "url": "u"})
        assert f"/messages/{segment}" in backend.last_call.url

    def test_send_location_contact_template(self):
        backend = MockBackend()
        backend.on("POST", "/send-location", body={"messageId": "m", "timestamp": 1})
        backend.on("POST", "/send-contact", body={"messageId": "m", "timestamp": 1})
        backend.on("POST", "/send-template", body={"messageId": "m", "timestamp": 1})
        client = make_client(backend)
        client.messages.send_location("s", {"chatId": "a@c.us", "latitude": -6.2, "longitude": 106.8})
        assert "/messages/send-location" in backend.last_call.url
        client.messages.send_contact("s", {"chatId": "a@c.us", "contactName": "A", "contactNumber": "628"})
        assert "/messages/send-contact" in backend.last_call.url
        # Server DTO field is `vars` (NOT `variables`); body forwarded verbatim.
        client.messages.send_template("s", {"chatId": "a@c.us", "templateId": "t", "vars": {"name": "Sam"}})
        assert "/messages/send-template" in backend.last_call.url
        assert backend.last_call.body == {"chatId": "a@c.us", "templateId": "t", "vars": {"name": "Sam"}}

    def test_send_template_accepts_template_name(self):
        backend = MockBackend().on("POST", "/send-template", body={"messageId": "m", "timestamp": 1})
        make_client(backend).messages.send_template("s", {"chatId": "a@c.us", "templateName": "welcome"})
        assert backend.last_call.body == {"chatId": "a@c.us", "templateName": "welcome"}

    def test_list_returns_messages_total_wrapper(self):
        backend = MockBackend().on("GET", "/messages", body={"messages": [{"id": "1"}], "total": 1})
        res = make_client(backend).messages.list("s")
        assert res["total"] == 1
        assert len(res["messages"]) == 1

    def test_reply_forwardReactDelete(self):
        backend = MockBackend()
        backend.on("POST", "/reply", body={"messageId": "m", "timestamp": 1})
        backend.on("POST", "/forward", body={"messageId": "m", "timestamp": 1})
        backend.on("POST", "/react", body={"success": True})
        backend.on("POST", "/delete", body={"success": True})
        client = make_client(backend)
        client.messages.reply("s", {"chatId": "a@c.us", "quotedMessageId": "q", "text": "r"})
        client.messages.forward("s", {"fromChatId": "a@c.us", "toChatId": "b@c.us", "messageId": "m"})
        client.messages.react("s", {"chatId": "a@c.us", "messageId": "m", "emoji": "👍"})
        client.messages.delete("s", {"chatId": "a@c.us", "messageId": "m"})
        assert "/messages/reply" in backend.calls[-4].url
        assert "/messages/forward" in backend.calls[-3].url
        assert "/messages/react" in backend.calls[-2].url
        assert "/messages/delete" in backend.calls[-1].url

    def test_history_and_reactions_path(self):
        backend = MockBackend()
        backend.on("GET", "/history", body=[])
        backend.on("GET", "/reactions", body=[])
        client = make_client(backend)
        client.messages.history("s", "a@c.us", {"limit": 5})
        assert "/messages/a@c.us/history" in backend.calls[-1].url
        assert "limit=5" in backend.calls[-1].url
        client.messages.reactions("s", "a@c.us", "m1")
        assert "/messages/a@c.us/m1/reactions" in backend.calls[-1].url

    def test_history_boolean_query_serializes_lowercase(self):
        # Server reads `includeMedia === 'true'`; Python str(True) == 'True' would be ignored.
        backend = MockBackend().on("GET", "/history", body=[])
        make_client(backend).messages.history("s", "a@c.us", {"limit": 5, "includeMedia": True, "deep": False})
        url = backend.last_call.url
        assert "includeMedia=true" in url
        assert "deep=false" in url

    def test_bulk_and_batch_status(self):
        backend = MockBackend()
        backend.on("POST", "/send-bulk", body={
            "batchId": "b", "status": "queued", "totalMessages": 1,
            "estimatedCompletionTime": "t", "statusUrl": "/u",
        })
        backend.on("GET", "/batch/b", body={
            "batchId": "b", "status": "done",
            "progress": {"total": 1, "sent": 1, "failed": 0, "pending": 0, "cancelled": 0},
            "results": [], "startedAt": "s", "completedAt": "c",
        })
        backend.on("POST", "/cancel", body={
            "batchId": "b", "status": "cancelled",
            "progress": {"total": 1, "sent": 0, "failed": 0, "pending": 0, "cancelled": 1},
        })
        client = make_client(backend)
        client.messages.send_bulk("s", {"messages": [{"chatId": "a@c.us", "type": "text", "content": {"text": "x"}}]})
        assert "/messages/send-bulk" in backend.calls[-1].url
        status = client.messages.batch_status("s", "b")
        assert status["progress"]["sent"] == 1
        assert "/messages/batch/b" in backend.calls[-1].url
        cancelled = client.messages.cancel_batch("s", "b")
        assert cancelled["status"] == "cancelled"
        assert "/messages/batch/b/cancel" in backend.calls[-1].url
        assert backend.calls[-1].method == "POST"


# ── Sessions ───────────────────────────────────────────────────────


class TestSessions:
    def test_lifecycle_paths(self):
        backend = MockBackend()
        backend.on("GET", "/api/sessions", body=[])
        backend.on("GET", "/sessions/s1", body={"id": "s1", "name": "n", "status": "ready"})
        backend.on("POST", "/api/sessions", body={"id": "s1", "name": "n", "status": "created"})
        backend.on("DELETE", "/sessions/s1", status=204)
        backend.on("POST", "/start", body={"id": "s1", "status": "initializing"})
        backend.on("POST", "/stop", body={"id": "s1", "status": "disconnected"})
        backend.on("POST", "/force-kill", body={"id": "s1", "status": "disconnected"})
        client = make_client(backend)
        client.sessions.list()
        assert backend.calls[-1].url == "http://localhost:2785/api/sessions"
        client.sessions.get("s1")
        assert "/sessions/s1" in backend.calls[-1].url
        client.sessions.create({"name": "n"})
        assert backend.calls[-1].body == {"name": "n"}
        client.sessions.start("s1")
        assert "/sessions/s1/start" in backend.calls[-1].url
        client.sessions.stop("s1")
        client.sessions.force_kill("s1")
        assert "/sessions/s1/force-kill" in backend.calls[-1].url
        client.sessions.delete("s1")
        assert backend.calls[-1].method == "DELETE"

    def test_qr_pairing_stats(self):
        backend = MockBackend()
        backend.on("GET", "/qr", body={"qrCode": "data:image/png;base64,xxx", "status": "qr_ready"})
        backend.on("POST", "/pairing-code", body={"pairingCode": "ABCD1234", "status": "qr_ready"})
        backend.on("GET", "/stats/overview", body={"total": 1, "active": 1, "ready": 1, "disconnected": 0, "byStatus": {"ready": 1}})
        client = make_client(backend)
        client.sessions.get_qr_code("s1")
        assert "/sessions/s1/qr" in backend.calls[-1].url
        client.sessions.request_pairing_code("s1", {"phoneNumber": "628123456789"})
        assert backend.calls[-1].body == {"phoneNumber": "628123456789"}
        client.sessions.stats()
        assert "/sessions/stats/overview" in backend.calls[-1].url


# ── Groups, Contacts, Webhooks, Chats, Health ──────────────────────


class TestGroups:
    def test_list_get_create(self):
        backend = MockBackend()
        backend.on("GET", "/groups", body=[])
        backend.on("GET", "/groups/g1@g.us", body={"id": "g1@g.us", "subject": "G", "participants": []})
        backend.on("POST", "/groups", body={"id": "g1@g.us", "subject": "G", "participants": []})
        client = make_client(backend)
        client.groups.list("s")
        client.groups.get("s", "g1@g.us")
        assert "/groups/g1@g.us" in backend.calls[-1].url
        client.groups.create("s", {"name": "G", "participants": ["a@c.us"]})
        assert backend.calls[-1].body == {"name": "G", "participants": ["a@c.us"]}

    def test_participant_ops(self):
        backend = MockBackend()
        backend.on("POST", "/participants", body={"success": True})
        backend.on("DELETE", "/participants", body={"success": True})
        backend.on("POST", "/promote", body={"success": True})
        backend.on("POST", "/demote", body={"success": True})
        client = make_client(backend)
        client.groups.add_participants("s", "g", ["a@c.us", "b@c.us"])
        assert backend.calls[-1].body == {"participants": ["a@c.us", "b@c.us"]}
        assert backend.calls[-1].method == "POST"
        client.groups.remove_participants("s", "g", ["a@c.us"])
        assert backend.calls[-1].method == "DELETE"
        client.groups.promote_participants("s", "g", ["a@c.us"])
        assert "/promote" in backend.calls[-1].url
        client.groups.demote_participants("s", "g", ["a@c.us"])
        assert "/demote" in backend.calls[-1].url

    def test_subject_description_invite(self):
        backend = MockBackend()
        backend.on("PUT", "/subject", body={"success": True})
        backend.on("PUT", "/description", body={"success": True})
        backend.on("POST", "/leave", body={"success": True})
        backend.on("GET", "/invite-code", body={"inviteCode": "c", "inviteLink": "l"})
        backend.on("POST", "/revoke", body={"inviteCode": "c2", "inviteLink": "l2"})
        client = make_client(backend)
        client.groups.set_subject("s", "g", "New")
        assert backend.calls[-1].body == {"subject": "New"}
        assert backend.calls[-1].method == "PUT"
        client.groups.set_description("s", "g", "desc")
        assert backend.calls[-1].body == {"description": "desc"}
        client.groups.leave("s", "g")
        client.groups.invite_code("s", "g")
        client.groups.revoke_invite_code("s", "g")
        assert "/revoke" in backend.calls[-1].url


class TestContacts:
    def test_paths(self):
        backend = MockBackend()
        backend.on("GET", "/contacts", body=[])
        backend.on("GET", "/contacts/a@c.us", body={"id": "a@c.us"})
        backend.on("GET", "/check/628123", body={"number": "628123", "exists": True, "whatsappId": "628123@c.us"})
        backend.on("GET", "/profile-picture", body={"url": "http://p"})
        backend.on("GET", "/phone", body={"contactId": "x@lid", "phone": "628123"})
        client = make_client(backend)
        client.contacts.list("s", {"limit": 10})
        assert "limit=10" in backend.calls[-1].url
        client.contacts.get("s", "a@c.us")
        client.contacts.check("s", "628123")
        assert "/check/628123" in backend.calls[-1].url
        client.contacts.profile_picture("s", "a@c.us")
        client.contacts.phone("s", "x@lid")

    def test_block_unblock(self):
        backend = MockBackend()
        backend.on("POST", "/block", body={"success": True})
        backend.on("DELETE", "/block", body={"success": True})
        client = make_client(backend)
        client.contacts.block("s", "a@c.us")
        assert backend.calls[-1].method == "POST"
        client.contacts.unblock("s", "a@c.us")
        assert backend.calls[-1].method == "DELETE"


class TestWebhooks:
    def test_crud_test(self):
        wh = {"id": "w1", "sessionId": "s", "url": "u", "events": ["*"], "active": True, "createdAt": "", "updatedAt": ""}
        backend = MockBackend()
        backend.on("GET", "/webhooks", body=[wh])
        backend.on("GET", "/webhooks/w1", body=wh)
        backend.on("POST", "/webhooks", body=wh)
        backend.on("PUT", "/webhooks/w1", body={**wh, "active": False})
        backend.on("DELETE", "/webhooks/w1", status=204)
        backend.on("POST", "/test", body={"success": True})
        client = make_client(backend)
        client.webhooks.list("s")
        client.webhooks.get("s", "w1")
        # Server DTO field is `retryCount` (NOT `retries`); body forwarded verbatim.
        client.webhooks.create("s", {"url": "u", "events": ["*"], "retryCount": 5})
        assert backend.calls[-1].body == {"url": "u", "events": ["*"], "retryCount": 5}
        client.webhooks.update("s", "w1", {"active": False})
        assert backend.calls[-1].method == "PUT"
        client.webhooks.delete("s", "w1")
        client.webhooks.test("s", "w1")
        assert "/webhooks/w1/test" in backend.calls[-1].url


class TestStatus:
    def test_send_image_video_forward_nested_media_body(self):
        backend = MockBackend()
        backend.on("POST", "/status/send-image", body={"statusId": "s1"})
        backend.on("POST", "/status/send-video", body={"statusId": "s2"})
        client = make_client(backend)
        # Server requires a nested {image|video:{...}} body, not flat media fields.
        client.status.send_image("s", {"image": {"url": "http://img"}, "caption": "hi"})
        assert backend.calls[-1].body == {"image": {"url": "http://img"}, "caption": "hi"}
        client.status.send_video("s", {"video": {"url": "http://vid"}})
        assert backend.calls[-1].body == {"video": {"url": "http://vid"}}


class TestChatsAndHealth:
    def test_chats(self):
        backend = MockBackend()
        backend.on("GET", "/chats", body=[])
        backend.on("POST", "/read", body={"success": True})
        backend.on("POST", "/unread", body={"success": True})
        backend.on("POST", "/delete", body={"success": True})
        backend.on("POST", "/typing", body={"success": True})
        client = make_client(backend)
        client.chats.list("s")
        client.chats.mark_read("s", {"chatId": "a@c.us"})
        assert "/chats/read" in backend.calls[-1].url
        client.chats.mark_unread("s", {"chatId": "a@c.us"})
        client.chats.delete("s", {"chatId": "a@c.us"})
        client.chats.send_state("s", {"chatId": "a@c.us", "state": "typing"})
        assert "/chats/typing" in backend.calls[-1].url

    def test_health_and_auth(self):
        backend = MockBackend()
        backend.on("GET", "/api/health", body={"status": "ok", "version": "0.7.2"})
        backend.on("GET", "/live", body={"status": "ok"})
        backend.on("GET", "/ready", body={"status": "ok", "details": {}})
        backend.on("POST", "/validate", body={"valid": True, "role": "admin"})
        client = make_client(backend)
        client.health.check()
        assert backend.calls[-1].url == "http://localhost:2785/api/health"
        client.health.live()
        client.health.ready()
        client.auth()
        assert backend.calls[-1].method == "POST"
        assert "/auth/validate" in backend.calls[-1].url


class TestLabelsChannelsCatalog:
    def test_labels(self):
        backend = MockBackend()
        backend.on("GET", "/labels", body=[{"id": "l1", "name": "VIP"}])
        backend.on("GET", "/labels/l1", body={"id": "l1", "name": "VIP"})
        backend.on("GET", "/labels/chat/a@c.us", body=[{"id": "l1", "name": "VIP"}])
        backend.on("POST", "/labels/chat/a@c.us", body={"success": True})
        backend.on("DELETE", "/labels/chat/a@c.us/l1", body={"success": True})
        client = make_client(backend)
        client.labels.list("s")
        assert "/sessions/s/labels" in backend.calls[-1].url
        client.labels.get("s", "l1")
        client.labels.for_chat("s", "a@c.us")
        client.labels.add_to_chat("s", "a@c.us", {"labelId": "l1"})
        assert backend.calls[-1].method == "POST"
        assert backend.calls[-1].body == {"labelId": "l1"}
        client.labels.remove_from_chat("s", "a@c.us", "l1")
        assert backend.calls[-1].method == "DELETE"

    def test_channels(self):
        backend = MockBackend()
        backend.on("GET", "/channels", body=[{"id": "123@newsletter", "name": "News"}])
        backend.on("GET", "/channels/123@newsletter", body={"id": "123@newsletter", "name": "News"})
        backend.on("GET", "/channels/123@newsletter/messages", body=[])
        backend.on("POST", "/channels/subscribe", body={"id": "123@newsletter", "name": "News"})
        backend.on("DELETE", "/channels/123@newsletter", body={"success": True})
        client = make_client(backend)
        client.channels.list("s")
        assert "/sessions/s/channels" in backend.calls[-1].url
        client.channels.get("s", "123@newsletter")
        client.channels.messages("s", "123@newsletter", {"limit": 10})
        assert "limit=10" in backend.calls[-1].url
        client.channels.subscribe("s", {"inviteCode": "ABCxyz"})
        assert backend.calls[-1].method == "POST"
        assert backend.calls[-1].body == {"inviteCode": "ABCxyz"}
        client.channels.unsubscribe("s", "123@newsletter")
        assert backend.calls[-1].method == "DELETE"

    def test_catalog(self):
        backend = MockBackend()
        backend.on("GET", "/catalog", body={"id": "c1", "name": "My Shop", "productCount": 5, "url": "http://shop"})
        backend.on("GET", "/catalog/products", body={
            "products": [{"id": "p1", "name": "Widget"}],
            "pagination": {"page": 1, "limit": 20, "total": 1, "totalPages": 1},
        })
        backend.on("GET", "/catalog/products/p1", body={"id": "p1", "name": "Widget"})
        backend.on("POST", "/messages/send-product", body={"messageId": "m", "timestamp": 1})
        backend.on("POST", "/messages/send-catalog", body={"messageId": "m", "timestamp": 1})
        client = make_client(backend)
        client.catalog.info("s")
        assert "/sessions/s/catalog" in backend.calls[-1].url
        page = client.catalog.products("s", {"page": 1, "limit": 20})
        assert page["pagination"]["total"] == 1
        assert "page=1" in backend.calls[-1].url
        client.catalog.product("s", "p1")
        client.catalog.send_product("s", {"chatId": "a@c.us", "productId": "p1", "body": "x"})
        assert "/messages/send-product" in backend.calls[-1].url
        assert backend.calls[-1].body == {"chatId": "a@c.us", "productId": "p1", "body": "x"}
        client.catalog.send_catalog("s", {"chatId": "a@c.us", "body": "cat"})
        assert "/messages/send-catalog" in backend.calls[-1].url

    def test_templates_crud(self):
        tpl = {"id": "t1", "sessionId": "s", "name": "welcome", "body": "Hi {{name}}", "createdAt": "", "updatedAt": ""}
        backend = MockBackend()
        backend.on("GET", "/templates/t1", body=tpl)
        backend.on("GET", "/templates", body=[tpl])
        backend.on("POST", "/templates", body=tpl)
        backend.on("PUT", "/templates/t1", body={**tpl, "body": "Hello {{name}}"})
        backend.on("DELETE", "/templates/t1", status=204)
        client = make_client(backend)
        client.templates.list("s")
        assert "/api/sessions/s/templates" in backend.last_call.url
        client.templates.get("s", "t1")
        assert backend.last_call.url.endswith("/api/sessions/s/templates/t1")
        client.templates.create("s", {"name": "welcome", "body": "Hi {{name}}"})
        assert backend.last_call.method == "POST"
        assert backend.last_call.body == {"name": "welcome", "body": "Hi {{name}}"}
        client.templates.update("s", "t1", {"body": "Hello {{name}}"})
        assert backend.last_call.method == "PUT"
        assert backend.last_call.body == {"body": "Hello {{name}}"}
        client.templates.delete("s", "t1")
        assert backend.last_call.method == "DELETE"

    def test_client_exposes_all_resources(self):
        client = make_client(MockBackend())
        for r in ["sessions", "messages", "contacts", "groups", "webhooks", "chats", "status", "health", "labels", "channels", "catalog", "templates"]:
            assert hasattr(client, r)
