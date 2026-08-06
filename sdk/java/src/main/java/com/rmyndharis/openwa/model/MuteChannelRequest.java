package com.rmyndharis.openwa.model;

/**
 * Body for muting or unmuting a channel.
 *
 * @param mute {@code true} mutes, {@code false} unmutes; the subscription is unaffected either way
 */
public record MuteChannelRequest(boolean mute) {}
