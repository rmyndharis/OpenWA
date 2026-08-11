package com.rmyndharis.openwa.model;

/**
 * Query parameters for the cross-session webhook list and the delivery-failure log. Null fields are
 * omitted from the query string.
 *
 * @param sessionId restrict to one session; ignored by the plain webhook list
 * @param limit maximum number of records to return
 * @param offset number of records to skip
 */
public record DeliveryFailureQuery(String sessionId, Integer limit, Integer offset) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String sessionId;
        private Integer limit;
        private Integer offset;

        public Builder sessionId(String v) {
            this.sessionId = v;
            return this;
        }

        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        public Builder offset(Integer v) {
            this.offset = v;
            return this;
        }

        public DeliveryFailureQuery build() {
            return new DeliveryFailureQuery(sessionId, limit, offset);
        }
    }
}
