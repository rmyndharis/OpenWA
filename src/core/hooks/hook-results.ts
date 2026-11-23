import type { HookEvent } from './hook.interfaces';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** A message:received / message:sent result the projector can store and dispatch: it keeps `id` and `chatId`. */
export function isMessagePayload(data: unknown): boolean {
  if (!isPlainObject(data)) return false;
  return typeof data.id === 'string' && typeof data.chatId === 'string';
}

/** A webhook:before result whose own plain-object `payload` can replace the one being sent. */
export function isWebhookBeforeResult(data: unknown): boolean {
  return isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, 'payload') && isPlainObject(data.payload);
}

/**
 * The handler results each event can use. A chain skips a result that fails its check and keeps the
 * last usable value, so an earlier handler's rewrite (a redaction) survives a later handler returning
 * `null`: HookManager applies it between plugins, the sandbox worker between one plugin's handlers.
 */
export const HOOK_RESULT_ACCEPT: Partial<Record<HookEvent, (data: unknown) => boolean>> = {
  'message:received': isMessagePayload,
  'message:sent': isMessagePayload,
  'webhook:before': isWebhookBeforeResult,
};
