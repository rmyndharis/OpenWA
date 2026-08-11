package com.rmyndharis.openwa.model;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSerializationContext;
import com.google.gson.JsonSerializer;
import java.lang.reflect.Type;

/**
 * Emits only the fields the caller actually addressed: a {@code clear*} flag becomes an explicit
 * null, a non-null box becomes its value, and a field that is neither is left out so the server
 * leaves it unchanged.
 *
 * <p>Registered on the client's single Gson for this type only — a global {@code serializeNulls()}
 * would turn every unset field of every other request body into an explicit null, which for this
 * route means "reset to default" and would be far worse than the gap it fixes.
 */
public final class UpdateSessionConfigRequestSerializer implements JsonSerializer<UpdateSessionConfigRequest> {
    @Override
    public JsonElement serialize(UpdateSessionConfigRequest src, Type type, JsonSerializationContext ctx) {
        JsonObject out = new JsonObject();
        if (src.clearAutoRejectCalls()) {
            out.add("autoRejectCalls", null);
        } else if (src.autoRejectCalls() != null) {
            out.addProperty("autoRejectCalls", src.autoRejectCalls());
        }
        if (src.clearMaxReconnectAttempts()) {
            out.add("maxReconnectAttempts", null);
        } else if (src.maxReconnectAttempts() != null) {
            out.addProperty("maxReconnectAttempts", src.maxReconnectAttempts());
        }
        if (src.clearReconnectBaseDelay()) {
            out.add("reconnectBaseDelay", null);
        } else if (src.reconnectBaseDelay() != null) {
            out.addProperty("reconnectBaseDelay", src.reconnectBaseDelay());
        }
        return out;
    }
}
