package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.ArchiveChatRequest;
import com.rmyndharis.openwa.model.ChatPresence;
import com.rmyndharis.openwa.model.ChatSummary;
import com.rmyndharis.openwa.model.DeleteChatRequest;
import com.rmyndharis.openwa.model.ListChatsQuery;
import com.rmyndharis.openwa.model.MarkChatRequest;
import com.rmyndharis.openwa.model.SendChatStateRequest;
import com.rmyndharis.openwa.model.SuccessResult;
import java.util.List;

/**
 * Chats resource — chat-list operations (read/unread/delete/typing state).
 *
 * <p>NOTE: these endpoints live under the session controller
 * ({@code /api/sessions/:id/chats/*}), but are surfaced here as a dedicated
 * resource for clarity.
 */
public final class ChatsResource {
    private final OpenWAClient client;

    public ChatsResource(OpenWAClient client) {
        this.client = client;
    }

    /** List active chats, most recent first. */
    public List<ChatSummary> list(String sessionId) {
        return list(sessionId, null);
    }

    /** List active chats, most recent first. */
    public List<ChatSummary> list(String sessionId, ListChatsQuery query) {
        return client.requestList(
            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/chats", query, null, ChatSummary.class);
    }

    /**
     * Subscribe to a chat's presence; updates then arrive as {@code presence.update} events. Presence
     * cannot be fetched from either engine, only received.
     *
     * <p>The subscription belongs to the connection and does NOT survive a restart or an automatic
     * reconnect, so re-issue it when the session comes back. Subscribe per chat: WhatsApp emits an
     * update on every transition. whatsapp-web.js answers {@code 501}.
     */
    public SuccessResult subscribePresence(String sessionId, MarkChatRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/presence/subscribe",
            null,
            body,
            SuccessResult.class);
    }

    /**
     * The last presence reported for a chat, or {@code null} when none has been — the chat was never
     * subscribed, or nothing has changed since. Held in memory, so a restart clears it.
     */
    public ChatPresence getPresence(String sessionId, String chatId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/presence/" + encodeSegment(chatId),
            null,
            null,
            ChatPresence.class);
    }

    /** Mark a chat as read/seen. */
    public SuccessResult markRead(String sessionId, MarkChatRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/chats/read", null, body, SuccessResult.class);
    }

    /** Mark a chat as unread. */
    public SuccessResult markUnread(String sessionId, MarkChatRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/chats/unread", null, body, SuccessResult.class);
    }

    /** Delete every message in a chat, keeping the chat itself. */
    public SuccessResult clearMessages(String sessionId, String chatId) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/chats/" + encodeSegment(chatId) + "/messages",
            null,
            null,
            SuccessResult.class);
    }

    /**
     * Archive or unarchive a chat. A false success means the engine declined — on Baileys a chat
     * with no known history cannot be archived.
     */
    public SuccessResult archive(String sessionId, ArchiveChatRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/chats/archive", null, body, SuccessResult.class);
    }

    /** Delete a chat from the chat list. */
    public SuccessResult delete(String sessionId, DeleteChatRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/chats/delete", null, body, SuccessResult.class);
    }

    /** Send a chat presence state (typing/recording/paused). */
    public SuccessResult sendState(String sessionId, SendChatStateRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/chats/typing", null, body, SuccessResult.class);
    }
}
