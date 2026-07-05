package com.rmyndharis.openwa.model;

import java.util.List;

/** A set of conditions gating whether an event is delivered to a webhook. */
public record WebhookFilters(List<WebhookFilterCondition> conditions) {}
