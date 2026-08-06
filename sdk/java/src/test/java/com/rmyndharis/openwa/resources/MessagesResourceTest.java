package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.BinaryResponse;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.BulkMessageContent;
import com.rmyndharis.openwa.model.BulkMessageItem;
import com.rmyndharis.openwa.model.BulkMessageType;
import com.rmyndharis.openwa.model.DeleteMessageRequest;
import com.rmyndharis.openwa.model.EditMessageRequest;
import com.rmyndharis.openwa.model.ForwardMessageRequest;
import com.rmyndharis.openwa.model.ListMessagesQuery;
import com.rmyndharis.openwa.model.MessageHistoryQuery;
import com.rmyndharis.openwa.model.PinMessageRequest;
import com.rmyndharis.openwa.model.ReactMessageRequest;
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
import com.rmyndharis.openwa.model.UnpinMessageRequest;
import com.rmyndharis.openwa.support.MockTransport;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class MessagesResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    private static final String MSG = "{\"messageId\":\"m1\",\"timestamp\":123}";

    @Test
    void listHitsMessagesPathWithQuery() {
        tx.respond(200, "{\"messages\":[],\"total\":0}");
        client.messages.list("s", ListMessagesQuery.builder().chatId("628@c.us").limit(10).build());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
        assertTrue(tx.lastRequest().url().startsWith("http://h/api/sessions/s/messages?"));
        assertTrue(tx.lastRequest().url().contains("limit=10"));
    }

    @Test
    void listEncodesSessionId() {
        tx.respond(200, "{\"messages\":[],\"total\":0}");
        client.messages.list("a/b", null);
        assertEquals("http://h/api/sessions/a%2Fb/messages", tx.lastRequest().url());
    }

    @Test
    void sendTextResolvesToSendTextPath() {
        tx.respond(200, MSG);
        client.messages.sendText("s", SendTextRequest.builder().chatId("628@c.us").text("hello-text").build());
        assertEquals("http://h/api/sessions/s/messages/send-text", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("hello-text"));
    }

    @Test
    void sendTextForwardsMentionsVerbatim() {
        tx.respond(200, MSG);
        client.messages.sendText(
            "s",
            SendTextRequest.builder()
                .chatId("120363@g.us")
                .text("hi @628123")
                .mentions(List.of("628123@c.us"))
                .build());
        assertTrue(tx.lastRequest().body().contains("\"mentions\":[\"628123@c.us\"]"));
    }

    @Test
    void sendPollResolvesToSendPollPath() {
        tx.respond(200, MSG);
        client.messages.sendPoll(
            "s",
            SendPollRequest.builder()
                .chatId("628@c.us")
                .name("Where?")
                .options(List.of("Park", "Beach"))
                .allowMultipleAnswers(true)
                .build());
        assertEquals("http://h/api/sessions/s/messages/send-poll", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"name\":\"Where?\""));
        assertTrue(tx.lastRequest().body().contains("\"options\":[\"Park\",\"Beach\"]"));
        assertTrue(tx.lastRequest().body().contains("\"allowMultipleAnswers\":true"));
    }

    @Test
    void sendImageResolvesToSendImagePath() {
        tx.respond(200, MSG);
        client.messages.sendImage("s", SendMediaRequest.builder().chatId("628@c.us").url("http://image-url").build());
        assertEquals("http://h/api/sessions/s/messages/send-image", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("image-url"));
    }

    @Test
    void sendVideoResolvesToSendVideoPath() {
        tx.respond(200, MSG);
        client.messages.sendVideo("s", SendMediaRequest.builder().chatId("628@c.us").url("http://video-url").build());
        assertEquals("http://h/api/sessions/s/messages/send-video", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("video-url"));
    }

    @Test
    void sendAudioResolvesToSendAudioPath() {
        tx.respond(200, MSG);
        client.messages.sendAudio(
            "s", SendAudioRequest.builder().chatId("628@c.us").url("http://audio-url").ptt(true).build());
        assertEquals("http://h/api/sessions/s/messages/send-audio", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("audio-url"));
    }

    @Test
    void sendDocumentResolvesToSendDocumentPath() {
        tx.respond(200, MSG);
        client.messages.sendDocument(
            "s", SendMediaRequest.builder().chatId("628@c.us").url("http://doc-url").filename("doc.pdf").build());
        assertEquals("http://h/api/sessions/s/messages/send-document", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("doc.pdf"));
    }

    @Test
    void sendStickerResolvesToSendStickerPath() {
        tx.respond(200, MSG);
        client.messages.sendSticker(
            "s", SendMediaRequest.builder().chatId("628@c.us").url("http://sticker-url").build());
        assertEquals("http://h/api/sessions/s/messages/send-sticker", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("sticker-url"));
    }

    @Test
    void sendLocationHitsSendLocationPath() {
        tx.respond(200, MSG);
        client.messages.sendLocation(
            "s", SendLocationRequest.builder().chatId("628@c.us").latitude(12.5).longitude(98.7).build());
        assertEquals("http://h/api/sessions/s/messages/send-location", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("12.5"));
    }

    @Test
    void sendContactHitsSendContactPath() {
        tx.respond(200, MSG);
        client.messages.sendContact(
            "s",
            SendContactRequest.builder().chatId("628@c.us").contactName("Alice-Contact").contactNumber("628999").build());
        assertEquals("http://h/api/sessions/s/messages/send-contact", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("Alice-Contact"));
    }

    @Test
    void sendTemplateHitsSendTemplatePath() {
        tx.respond(200, MSG);
        client.messages.sendTemplate(
            "s", SendTemplateRequest.builder().chatId("628@c.us").templateName("welcome-tpl").build());
        assertEquals("http://h/api/sessions/s/messages/send-template", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("welcome-tpl"));
    }

    @Test
    void replyHitsReplyPath() {
        tx.respond(200, MSG);
        client.messages.reply(
            "s", ReplyMessageRequest.builder().chatId("628@c.us").quotedMessageId("quoted-123").text("re").build());
        assertEquals("http://h/api/sessions/s/messages/reply", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("quoted-123"));
    }

    @Test
    void forwardHitsForwardPath() {
        tx.respond(200, MSG);
        client.messages.forward(
            "s", ForwardMessageRequest.builder().fromChatId("a@c.us").toChatId("b@c.us").messageId("fwd-msg").build());
        assertEquals("http://h/api/sessions/s/messages/forward", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("fwd-msg"));
    }

    @Test
    void reactHitsReactPath() {
        tx.respond(200, "{\"success\":true}");
        client.messages.react(
            "s", ReactMessageRequest.builder().chatId("628@c.us").messageId("react-msg").emoji("👍").build());
        assertEquals("http://h/api/sessions/s/messages/react", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("react-msg"));
    }

    @Test
    void editMessageHitsEditPath() {
        tx.respond(200, MSG);
        client.messages.editMessage(
            "s", EditMessageRequest.builder().chatId("628@c.us").messageId("edit-msg").body("edited-text").build());
        assertEquals("http://h/api/sessions/s/messages/edit", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("edit-msg"));
        assertTrue(tx.lastRequest().body().contains("edited-text"));
    }

    @Test
    void deleteHitsDeletePath() {
        tx.respond(200, "{\"success\":true}");
        client.messages.delete(
            "s", DeleteMessageRequest.builder().chatId("628@c.us").messageId("del-msg").forEveryone(true).build());
        assertEquals("http://h/api/sessions/s/messages/delete", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("del-msg"));
    }

    @Test
    void historyHitsHistoryPathWithQuery() {
        tx.respond(200, "[]");
        client.messages.history("s", "chat1", MessageHistoryQuery.builder().limit(5).includeMedia(true).build());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
        assertTrue(tx.lastRequest().url().startsWith("http://h/api/sessions/s/messages/chat1/history?"));
        assertTrue(tx.lastRequest().url().contains("includeMedia=true"));
    }

    @Test
    void reactionsHitsReactionsPath() {
        tx.respond(200, "[]");
        client.messages.reactions("s", "chat1", "msg1");
        assertEquals("http://h/api/sessions/s/messages/chat1/msg1/reactions", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void sendBulkHitsSendBulkPath() {
        tx.respond(200, "{\"batchId\":\"b1\",\"status\":\"queued\",\"totalMessages\":1}");
        SendBulkRequest body = SendBulkRequest.builder()
            .messages(List.of(BulkMessageItem.builder()
                .chatId("628bulk@c.us")
                .type(BulkMessageType.TEXT)
                .content(BulkMessageContent.builder().text("hi").build())
                .build()))
            .build();
        client.messages.sendBulk("s", body);
        assertEquals("http://h/api/sessions/s/messages/send-bulk", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("628bulk"));
    }

    @Test
    void batchStatusHitsBatchPath() {
        tx.respond(200, "{\"batchId\":\"b1\",\"status\":\"running\"}");
        client.messages.batchStatus("s", "b1");
        assertEquals("http://h/api/sessions/s/messages/batch/b1", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void cancelBatchHitsCancelPath() {
        tx.respond(200, "{\"batchId\":\"b1\",\"status\":\"cancelled\"}");
        client.messages.cancelBatch("s", "b1");
        assertEquals("http://h/api/sessions/s/messages/batch/b1/cancel", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void mediaReturnsArchivedBytes() {
        tx.respondRaw(
            200,
            "PNG_BYTES".getBytes(StandardCharsets.UTF_8),
            Map.of("content-type", List.of("image/png")));
        BinaryResponse media = client.messages.media("s", "c1", "m1");
        assertEquals("http://h/api/sessions/s/messages/c1/m1/media", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
        assertArrayEquals("PNG_BYTES".getBytes(StandardCharsets.UTF_8), media.data());
        assertEquals("image/png", media.contentType());
    }

    @Test
    void pinAndUnpinPostToTheirRoutes() {
        tx.respond(200, "{\"success\":true}");
        client.messages.pin("s", PinMessageRequest.builder().chatId("c1").messageId("m1").build());
        assertEquals("http://h/api/sessions/s/messages/pin", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());

        tx.respond(200, "{\"success\":true}");
        client.messages.unpin("s", UnpinMessageRequest.builder().chatId("c1").messageId("m1").build());
        assertEquals("http://h/api/sessions/s/messages/unpin", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void starPostsToItsRoute() {
        tx.respond(200, "{\"success\":true}");
        client.messages.star("s", StarMessageRequest.builder().chatId("c1").messageId("m1").star(false).build());
        assertEquals("http://h/api/sessions/s/messages/star", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void votePollPostsToItsRoute() {
        tx.respond(200, "{\"success\":true}");
        client.messages.votePoll(
            "s", VotePollRequest.builder().chatId("c1").pollMessageId("p1").options(List.of("Pizza")).build());
        assertEquals("http://h/api/sessions/s/messages/vote-poll", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }
}
