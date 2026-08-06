package com.rmyndharis.openwa.model;

/** Query parameters for listing groups. Null fields are omitted from the query string. */
public record ListGroupsQuery(Integer limit, Integer offset) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Integer limit;
        private Integer offset;

        /** Maximum number of groups to return. */
        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        /** Number of groups to skip. */
        public Builder offset(Integer v) {
            this.offset = v;
            return this;
        }

        public ListGroupsQuery build() {
            return new ListGroupsQuery(limit, offset);
        }
    }
}
