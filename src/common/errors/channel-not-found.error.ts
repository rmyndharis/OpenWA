import { NotFoundException } from '@nestjs/common';

/**
 * Thrown by the engine layer when a channel referenced by id isn't among the session's subscribed
 * channels (a wrong/typo'd id, or a channel not yet synced into the local collection).
 *
 * Extends NestJS `NotFoundException` so it maps to **HTTP 404** through the built-in exception
 * handler — i.e. it does NOT depend on a custom global filter being registered, and it survives the
 * `channel.service` passthrough — instead of surfacing as a generic 500 Internal Server Error.
 * Mirrors {@link MessageNotFoundError}.
 */
export class ChannelNotFoundError extends NotFoundException {
  constructor(channelId: string) {
    super(`Channel ${channelId} not found`);
  }
}
