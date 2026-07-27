package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * A single condition evaluated against an event before delivery.
 *
 * <p>{@code value} is polymorphic per field kind: a {@link String} (text fields),
 * a {@code List<String>} (id/idArray/enum fields), or a {@link Boolean} (boolean
 * fields). {@code caseSensitive} only applies to text fields
 * ({@code contains}/{@code equals}) and defaults to false when {@code null}.
 */
public record WebhookFilterCondition(String field, String operator, Object value, Boolean caseSensitive) {
    /** Back-compatible constructor: id/enum value list, no caseSensitivity. */
    public WebhookFilterCondition(String field, String operator, List<String> value) {
        this(field, operator, (Object) value, null);
    }
}
