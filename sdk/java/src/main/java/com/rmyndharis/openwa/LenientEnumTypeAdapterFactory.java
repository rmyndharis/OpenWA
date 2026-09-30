package com.rmyndharis.openwa;

import com.google.gson.Gson;
import com.google.gson.TypeAdapter;
import com.google.gson.TypeAdapterFactory;
import com.google.gson.reflect.TypeToken;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import com.google.gson.stream.JsonWriter;
import java.io.IOException;

/**
 * Decodes a wire token this SDK does not know to the enum's {@code UNKNOWN} constant instead of
 * null, so a value the gateway added later is not mistaken for an absent field. Enums without an
 * {@code UNKNOWN} constant keep Gson's default, and writing is unchanged.
 */
final class LenientEnumTypeAdapterFactory implements TypeAdapterFactory {
    @Override
    @SuppressWarnings("unchecked")
    public <T> TypeAdapter<T> create(Gson gson, TypeToken<T> type) {
        Class<? super T> raw = type.getRawType();
        if (!raw.isEnum()) {
            return null;
        }
        T unknown = null;
        for (Object constant : raw.getEnumConstants()) {
            if (((Enum<?>) constant).name().equals("UNKNOWN")) {
                unknown = (T) constant;
            }
        }
        if (unknown == null) {
            return null;
        }
        TypeAdapter<T> delegate = gson.getDelegateAdapter(this, type);
        T fallback = unknown;
        return new TypeAdapter<T>() {
            @Override
            public void write(JsonWriter out, T value) throws IOException {
                delegate.write(out, value);
            }

            @Override
            public T read(JsonReader in) throws IOException {
                if (in.peek() == JsonToken.NULL) {
                    in.nextNull();
                    return null;
                }
                T value = delegate.read(in);
                return value != null ? value : fallback;
            }
        };
    }
}
