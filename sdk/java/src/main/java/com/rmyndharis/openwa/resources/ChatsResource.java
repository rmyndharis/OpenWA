package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
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
