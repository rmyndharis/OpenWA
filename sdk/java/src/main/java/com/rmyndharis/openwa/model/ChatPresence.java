package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * The last presence reported for a chat since it was subscribed.
 *
 * @param groupOnlineCount online member count, groups only
 * @param observedAt when the gateway received the report — NOT a WhatsApp timestamp
 */
public record ChatPresence(
    String chatId, List<ParticipantPresence> participants, Integer groupOnlineCount, String observedAt) {}
