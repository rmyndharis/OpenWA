package com.rmyndharis.openwa.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The chat-history route returns the engine payload verbatim, so nothing between the wire and a
 * caller checks these record components. MessagesResourceTest responds with {@code []} and asserts
 * the URL only, so without this the deserialization is unexercised.
 */
class ChatHistoryMessageDecodeTest {

    private static final Gson GSON = new Gson();

    @Test
    void decodesTheEnginePayloadFields() {
        String json = "{\"id\":\"true_628@c.us_ABC\",\"from\":\"628@c.us\",\"to\":\"629@c.us\","
            + "\"chatId\":\"628@c.us\",\"body\":\"\",\"type\":\"call\",\"timestamp\":1719312000,"
            + "\"fromMe\":false,\"isGroup\":false,\"kind\":\"individual\",\"ephemeralDuration\":604800,"
            + "\"isForwarded\":true,\"forwardingScore\":2,"
            + "\"call\":{\"video\":true,\"missed\":false},"
            + "\"contact\":{\"pushName\":\"Budi\",\"number\":\"628\",\"isMyContact\":true,"
            + "\"verifiedLevel\":0,\"labels\":[\"vip\"]}}";

        ChatHistoryMessage m = GSON.fromJson(json, ChatHistoryMessage.class);

        assertEquals(604800, m.ephemeralDuration());
        assertTrue(m.isForwarded());
        assertEquals(2L, m.forwardingScore());
        assertNotNull(m.call());
        assertTrue(m.call().video());
        assertFalse(m.call().missed());
        assertNotNull(m.contact());
        assertEquals("Budi", m.contact().pushName());
        assertEquals("628", m.contact().number());
        assertTrue(m.contact().isMyContact());
        assertEquals(List.of("vip"), m.contact().labels());
        // Boxed, so level 0 (unverified) stays distinguishable from "the server said nothing".
        assertEquals(0, m.contact().verifiedLevel());
    }

    @Test
    void decodesPollChoicesWithoutTrimming() {
        var m = GSON.fromJson("{\"poll\":{\"name\":\"Q\",\"options\":[\" Park \",\"Beach\"],\"allowMultipleAnswers\":true}}", ChatHistoryMessage.class);
        assertEquals("Q", m.poll().name());
        assertEquals(List.of(" Park ", "Beach"), m.poll().options());
        assertTrue(m.poll().allowMultipleAnswers());
        var legacy = new ChatHistoryMessage("id", "from", "to", "chat", "Q", MessageType.POLL,
            1L, false, false, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null);
        assertNull(legacy.poll());
        assertNull(legacy.isForwarded());
    }

    @Test
    void decodesTheLargestForwardingScore() {
        // The sender writes the counter as an unsigned 32-bit value: it must not overflow a Long.
        var m = GSON.fromJson("{\"isForwarded\":true,\"forwardingScore\":4294967295}", ChatHistoryMessage.class);
        assertEquals(4294967295L, m.forwardingScore());
    }

    @Test
    void leavesAbsentOptionalsNull() {
        String json = "{\"id\":\"x\",\"from\":\"a\",\"to\":\"b\",\"chatId\":\"c\",\"body\":\"\","
            + "\"type\":\"text\",\"timestamp\":1,\"fromMe\":false,\"isGroup\":false,\"kind\":\"individual\"}";

        ChatHistoryMessage m = GSON.fromJson(json, ChatHistoryMessage.class);

        assertNull(m.poll());
        assertNull(m.call());
        assertNull(m.contact());
        assertNull(m.ephemeralDuration());
        assertNull(m.isForwarded());
        assertNull(m.forwardingScore());
        assertNull(m.font());
        assertNull(m.backgroundColor());
    }
}
