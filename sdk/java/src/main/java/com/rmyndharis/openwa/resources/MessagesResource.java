package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.BinaryResponse;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.BatchStatusResponse;
import com.rmyndharis.openwa.model.BulkMessageResponse;
import com.rmyndharis.openwa.model.ChatHistoryMessage;
import com.rmyndharis.openwa.model.DeleteMessageRequest;
import com.rmyndharis.openwa.model.EditMessageRequest;
import com.rmyndharis.openwa.model.ForwardMessageRequest;
import com.rmyndharis.openwa.model.ListMessagesQuery;
import com.rmyndharis.openwa.model.MessageHistoryQuery;
import com.rmyndharis.openwa.model.MessageListResponse;
import com.rmyndharis.openwa.model.MessageResponse;
import com.rmyndharis.openwa.model.PinMessageRequest;
import com.rmyndharis.openwa.model.ReactMessageRequest;
import com.rmyndharis.openwa.model.ReactionRecord;
import com.rmyndharis.openwa.model.ReplyMessageRequest;
import com.rmyndharis.openwa.model.SendBulkRequest;
import com.rmyndharis.openwa.model.SendContactRequest;
import com.rmyndharis.openwa.model.SendLocationRequest;
import com.rmyndharis.openwa.model.SendMediaRequest;
import com.rmyndharis.openwa.model.SendAudioRequest;
import com.rmyndharis.openwa.model.SendPollRequest;
import com.rmyndharis.openwa.model.SendTemplateRequest;
import com.rmyndharis.openwa.model.SendTextRequest;
import com.rmyndharis.openwa.model.StarMessageRequest;
import com.rmyndharis.openwa.model.VotePollRequest;
import com.rmyndharis.openwa.model.SuccessResult;
import com.rmyndharis.openwa.model.UnpinMessageRequest;
import java.util.List;

/**
 * Messages resource — sending and querying messages.
 *
 * <p>The real routes use the {@code /send-} prefix, e.g. {@code /messages/send-text}.
 */
public final class MessagesResource {
    private final OpenWAClient client;

    public MessagesResource(OpenWAClient client) {
        this.client = client;
    }

    /** List messages, optionally filtered by chat or sender. Returns a {@code { messages, total }} page. */
    public MessageListResponse list(String sessionId, ListMessagesQuery query) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages",
            query,
            null,
            MessageListResponse.class);
    }

    /** Send a text message. */
    public MessageResponse sendText(String sessionId, SendTextRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-text",
            null,
            body,
            MessageResponse.class);
    }

    /** Send an image (url or base64). */
    public MessageResponse sendImage(String sessionId, SendMediaRequest body) {
        return sendMedia(sessionId, "send-image", body);
    }

    /** Send a video (url or base64). */
    public MessageResponse sendVideo(String sessionId, SendMediaRequest body) {
        return sendMedia(sessionId, "send-video", body);
    }

    /** Send an audio file (url or base64). */
    public MessageResponse sendAudio(String sessionId, SendAudioRequest body) {
        return sendMedia(sessionId, "send-audio", body);
    }

    /** Send a document (url or base64; {@code filename} required). */
    public MessageResponse sendDocument(String sessionId, SendMediaRequest body) {
        return sendMedia(sessionId, "send-document", body);
    }

    /** Send a sticker (url or base64). */
    public MessageResponse sendSticker(String sessionId, SendMediaRequest body) {
        return sendMedia(sessionId, "send-sticker", body);
    }

    /** Send a location. */
    public MessageResponse sendLocation(String sessionId, SendLocationRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-location",
            null,
            body,
            MessageResponse.class);
    }

    /** Send a contact card. */
    public MessageResponse sendContact(String sessionId, SendContactRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-contact",
            null,
            body,
            MessageResponse.class);
    }

    /** Render and send a stored message template. */
    public MessageResponse sendTemplate(String sessionId, SendTemplateRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-template",
            null,
            body,
            MessageResponse.class);
    }

    /** Send a native WhatsApp poll (2–12 options). */
    public MessageResponse sendPoll(String sessionId, SendPollRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-poll",
            null,
            body,
            MessageResponse.class);
    }

    /** Reply to a specific message. */
    public MessageResponse reply(String sessionId, ReplyMessageRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/reply",
            null,
            body,
            MessageResponse.class);
    }

    /** Forward a message to another chat. */
    public MessageResponse forward(String sessionId, ForwardMessageRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/forward",
            null,
            body,
            MessageResponse.class);
    }

    /** React to a message (an empty {@code emoji} removes the reaction). */
    public SuccessResult react(String sessionId, ReactMessageRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/react",
            null,
            body,
            SuccessResult.class);
    }

    /**
     * Pin a message in its chat. durationSeconds must be 86400 (24h), 604800 (7d) or 2592000 (30d);
     * omit it for the server default of 24h. In a group only admins may pin.
     */
    public SuccessResult pin(String sessionId, PinMessageRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/pin",
            null,
            body,
            SuccessResult.class);
    }

    /** Cast a vote on a poll. Not supported on the Baileys engine (501). */
    public SuccessResult votePoll(String sessionId, VotePollRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/vote-poll",
            null,
            body,
            SuccessResult.class);
    }

    /**
     * Star or unstar a message. Best-effort on whatsapp-web.js, which silently ignores a message it
     * will not star.
     */
    public SuccessResult star(String sessionId, StarMessageRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/star",
            null,
            body,
            SuccessResult.class);
    }

    /** Remove a message's pin. */
    public SuccessResult unpin(String sessionId, UnpinMessageRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/unpin",
            null,
            body,
            SuccessResult.class);
    }

    /** Edit the text of a message sent by this account. 404 when the message is not found. */
    public MessageResponse editMessage(String sessionId, EditMessageRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/edit",
            null,
            body,
            MessageResponse.class);
    }

    /** Delete a message. */
    public SuccessResult delete(String sessionId, DeleteMessageRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/delete",
            null,
            body,
            SuccessResult.class);
    }

    /** Get the message history for a chat (read live from WhatsApp). */
    public List<ChatHistoryMessage> history(String sessionId, String chatId, MessageHistoryQuery query) {
        return client.requestList(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/" + encodeSegment(chatId) + "/history",
            query,
            null,
            ChatHistoryMessage.class);
    }

    /**
     * Fetch a message's archived media bytes (404 when nothing is archived for it).
     */
    public BinaryResponse media(String sessionId, String chatId, String messageId) {
        return client.requestBytes(
            HttpMethod.GET,
            "/api/sessions/"
                + encodeSegment(sessionId)
                + "/messages/"
                + encodeSegment(chatId)
                + "/"
                + encodeSegment(messageId)
                + "/media",
            null);
    }

    /** Get reactions for a specific message. */
    public List<ReactionRecord> reactions(String sessionId, String chatId, String messageId) {
        return client.requestList(
            HttpMethod.GET,
            "/api/sessions/"
                + encodeSegment(sessionId)
                + "/messages/"
                + encodeSegment(chatId)
                + "/"
                + encodeSegment(messageId)
                + "/reactions",
            null,
            null,
            ReactionRecord.class);
    }

    /**
     * Send a batch of messages asynchronously. Returns HTTP 202 with a batch id;
     * poll the status via {@link #batchStatus(String, String)}.
     */
    public BulkMessageResponse sendBulk(String sessionId, SendBulkRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-bulk",
            null,
            body,
            BulkMessageResponse.class);
    }

    /** Poll the status/progress of a bulk send batch. */
    public BatchStatusResponse batchStatus(String sessionId, String batchId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/batch/" + encodeSegment(batchId),
            null,
            null,
            BatchStatusResponse.class);
    }

    /** Cancel a running batch. Requires an OPERATOR-level key. */
    public BatchStatusResponse cancelBatch(String sessionId, String batchId) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/batch/" + encodeSegment(batchId) + "/cancel",
            null,
            null,
            BatchStatusResponse.class);
    }

    // ── Internal ───────────────────────────────────────────────────────

    /** POST {@code /messages/send-<kind>} for the five media send helpers. */
    private MessageResponse sendMedia(String sessionId, String kind, Object body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/" + kind,
            null,
            body,
            MessageResponse.class);
    }
}
