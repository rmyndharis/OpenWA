package com.rmyndharis.openwa.model;

/** Query params for {@code channels.messages(...)}. Gson omits null fields. */
public record ChannelMessageQuery(Integer limit) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Integer limit;

        /** Max messages to return (default 50). */
        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        public ChannelMessageQuery build() {
            return new ChannelMessageQuery(limit);
        }
    }
}
