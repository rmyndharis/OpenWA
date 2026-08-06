package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.AddLabelRequest;
import com.rmyndharis.openwa.model.ChatSummary;
import com.rmyndharis.openwa.model.LabelRecord;
import com.rmyndharis.openwa.model.UpsertLabelRequest;
import com.rmyndharis.openwa.model.SuccessResult;
import java.util.List;

/**
 * Labels resource — WhatsApp Business chat labels.
 *
 * <p>Labels are a WhatsApp Business feature; the session must be a business account.
 */
public final class LabelsResource {
    private final OpenWAClient client;

    public LabelsResource(OpenWAClient client) {
        this.client = client;
    }

    /** List all labels available in the business account. */
    public List<LabelRecord> list(String sessionId) {
        return client.requestList(
            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/labels", null, null, LabelRecord.class);
    }

    /** Get a single label by id. */
    public LabelRecord get(String sessionId, String labelId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/" + encodeSegment(labelId),
            null,
            null,
            LabelRecord.class);
    }

    /**
     * Every chat carrying a label. whatsapp-web.js only — Baileys has label writes but no label query
     * of any kind, and answers {@code 501}.
     */
    public List<ChatSummary> chats(String sessionId, String labelId) {
        return client.requestList(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/" + encodeSegment(labelId) + "/chats",
            null,
            null,
            ChatSummary.class);
    }

    /**
     * Create or update a label. Baileys only; whatsapp-web.js can read and assign labels but cannot
     * edit one, and answers {@code 501}.
     *
     * <p>{@code PUT} rather than {@code POST} because you choose the id: WhatsApp carries one write
     * keyed on it, so whether this creates or updates depends purely on whether that id already
     * exists. Pick an unused id to create — reusing one rewrites that label rather than failing.
     * Omitted fields are left alone.
     */
    public SuccessResult upsert(String sessionId, String labelId, UpsertLabelRequest body) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/" + encodeSegment(labelId),
            null,
            body,
            SuccessResult.class);
    }

    /** Delete a label; it disappears from every chat it was on. Baileys only. */
    public SuccessResult delete(String sessionId, String labelId) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/" + encodeSegment(labelId),
            null,
            null,
            SuccessResult.class);
    }

    /** Get the labels currently applied to a chat. */
    public List<LabelRecord> forChat(String sessionId, String chatId) {
        return client.requestList(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/chat/" + encodeSegment(chatId),
            null,
            null,
            LabelRecord.class);
    }

    /** Add a label to a chat. Requires an OPERATOR-level key. */
    public SuccessResult addToChat(String sessionId, String chatId, AddLabelRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/chat/" + encodeSegment(chatId),
            null,
            body,
            SuccessResult.class);
    }

    /** Remove a label from a chat. Requires an OPERATOR-level key. */
    public SuccessResult removeFromChat(String sessionId, String chatId, String labelId) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/chat/" + encodeSegment(chatId) + "/"
                + encodeSegment(labelId),
            null,
            null,
            SuccessResult.class);
    }
}
