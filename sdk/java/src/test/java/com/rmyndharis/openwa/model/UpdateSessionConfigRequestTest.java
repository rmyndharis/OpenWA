package com.rmyndharis.openwa.model;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.junit.jupiter.api.Test;

/**
 * The config route needs three states per field: an absent key leaves the value unchanged, an
 * explicit null clears it to the default, a value sets it. Gson omits nulls by default, so a record
 * of nullable boxes could only ever express two — and restoring unlimited reconnect attempts, the
 * one thing this route exists for, was unreachable.
 */
class UpdateSessionConfigRequestTest {
    // Mirrors the client's nullEmittingGson exactly: without serializeNulls the writer drops the
    // very null the serializer was written to emit.
    private final Gson gson = new GsonBuilder()
            .serializeNulls()
            .registerTypeAdapter(UpdateSessionConfigRequest.class, new UpdateSessionConfigRequestSerializer())
            .create();

    @Test
    void absentFieldsAreOmitted() {
        assertEquals("{}", gson.toJson(UpdateSessionConfigRequest.builder().build()));
    }

    @Test
    void aValueIsSent() {
        assertEquals(
                "{\"maxReconnectAttempts\":5}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .maxReconnectAttempts(5)
                        .build()));
    }

    @Test
    void clearSendsAnExplicitNull() {
        assertEquals(
                "{\"maxReconnectAttempts\":null}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .clearMaxReconnectAttempts()
                        .build()));
    }

    @Test
    void clearWinsOverAValueForTheSameField() {
        assertEquals(
                "{\"maxReconnectAttempts\":null}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .maxReconnectAttempts(5)
                        .clearMaxReconnectAttempts()
                        .build()));
    }

    @Test
    void oneClearedFieldDoesNotDragTheOthersIn() {
        assertEquals(
                "{\"autoRejectCalls\":true,\"maxReconnectAttempts\":null}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .autoRejectCalls(true)
                        .clearMaxReconnectAttempts()
                        .build()));
    }
}
