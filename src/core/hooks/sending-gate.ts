import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { cloneHookData, HookExecuteOptions, HookExecutionError, HookManager } from './hook-manager.service';
import { createLogger } from '../../common/services/logger.service';
import { markNothingSent } from '../../common/errors/engine-not-sent.error';

const logger = createLogger('SendingGate');

/**
 * Routing and targeting fields that plugins may inspect during `message:sending` but must never
 * retarget, remove, or inject onto the gated send input.
 */
const PINNED_ROUTING_FIELDS = ['chatId', 'toChatId', 'fromChatId', 'quotedMessageId', 'messageId'] as const;

const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_SANITIZE_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  // Check the prototype chain's root rather than identity with this realm's Object.prototype so
  // plain objects cloned across realms (e.g. structuredClone inside a VM context) still match.
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneGateInput<T extends object>(input: T): T {
  return cloneHookData(input);
}

function sanitizeNestedValue(value: unknown, seen: WeakMap<object, unknown>, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    throw new BadRequestException('Outbound message blocked: plugin hook payload exceeds maximum nesting depth');
  }
  if (Array.isArray(value)) {
    const cleanArray: unknown[] = [];
    seen.set(value, cleanArray);
    for (const item of value) {
      cleanArray.push(sanitizeNestedValue(item, seen, depth + 1));
    }
    return cleanArray;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const cleanObject: Record<string, unknown> = {};
  seen.set(value, cleanObject);
  for (const [key, entry] of Object.entries(value)) {
    if (!PROTOTYPE_POLLUTION_KEYS.has(key)) {
      cleanObject[key] = sanitizeNestedValue(entry, seen, depth + 1);
    }
  }
  return cleanObject;
}

/**
 * Recursively strip own `__proto__`, `constructor`, and `prototype` keys across a gated input
 * object and any nested plain objects or arrays, preserving non-plain values (such as Buffers and
 * Dates) and guarding against circular references.
 */
export function sanitizeGateInputObject(raw: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakMap<object, unknown>();
  const clean: Record<string, unknown> = {};
  seen.set(raw, clean);
  for (const [key, value] of Object.entries(raw)) {
    if (!PROTOTYPE_POLLUTION_KEYS.has(key)) {
      clean[key] = sanitizeNestedValue(value, seen, 1);
    }
  }
  return clean;
}

export interface PinnedRoutingSnapshot {
  fields: Array<{ field: string; present: boolean; value: unknown }>;
  optionsRecipients: { present: boolean; value: unknown };
}

/** Capture caller-owned routing fields (including StatusService `options.recipients`) before running hooks. */
export function capturePinnedRouting(input: object): PinnedRoutingSnapshot {
  const original = input as Record<string, unknown>;
  const fields = PINNED_ROUTING_FIELDS.map(field => ({
    field,
    present: Object.hasOwn(original, field) && original[field] !== undefined,
    value: original[field],
  }));

  let optionsRecipients: { present: boolean; value: unknown } = { present: false, value: undefined };
  if (Object.hasOwn(original, 'options') && isRecordObject(original.options)) {
    const origOptions = original.options;
    if (Object.hasOwn(origOptions, 'recipients') && origOptions.recipients !== undefined) {
      optionsRecipients = {
        present: true,
        value: cloneHookData(origOptions.recipients),
      };
    }
  }

  return { fields, optionsRecipients };
}

/** Recursively sanitize a gated input object and restore/strip all pinned routing fields from `snapshot`. */
export function applyPinnedRouting(
  raw: Record<string, unknown>,
  snapshot: PinnedRoutingSnapshot,
): Record<string, unknown> {
  const gated = sanitizeGateInputObject(raw);
  for (const { field, present, value } of snapshot.fields) {
    if (present) {
      gated[field] = value;
    } else {
      delete gated[field];
    }
  }
  if (Object.hasOwn(gated, 'options') && isRecordObject(gated.options)) {
    const gatedOptions = sanitizeGateInputObject(gated.options);
    if (snapshot.optionsRecipients.present) {
      gatedOptions.recipients = cloneHookData(snapshot.optionsRecipients.value);
    } else {
      delete gatedOptions.recipients;
    }
    gated.options = gatedOptions;
  } else if (snapshot.optionsRecipients.present) {
    gated.options = { recipients: cloneHookData(snapshot.optionsRecipients.value) };
  }
  return gated;
}

/**
 * Re-pin routing fields and sanitize nested keys on a valid `message:sending` envelope between
 * handlers in a chain. Malformed envelopes pass through untouched so the gate's fail-closed check
 * refuses them with 400.
 */
export function normalizeSendingEnvelope<T>(envelope: T, snapshot: PinnedRoutingSnapshot): T {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope) || !('input' in envelope)) {
    return envelope;
  }
  const record = envelope as Record<string, unknown>;
  if (typeof record.input !== 'object' || record.input === null || Array.isArray(record.input)) {
    return envelope;
  }
  return {
    ...record,
    input: applyPinnedRouting(record.input as Record<string, unknown>, snapshot),
  } as T;
}

/**
 * Build HookExecuteOptions for `message:sending` with per-handler data isolation and inter-handler
 * routing normalization attached non-enumerably so `{ sessionId, source }` keeps its exact
 * enumerable context shape.
 */
export function buildSendingExecuteOptions<T>(
  sessionId: string,
  source: string,
  snapshot: PinnedRoutingSnapshot,
): HookExecuteOptions<T> {
  const options: HookExecuteOptions<T> = { sessionId, source };
  Object.defineProperties(options, {
    isolateData: { value: true, enumerable: false },
    normalizeData: {
      value: (data: T) => normalizeSendingEnvelope(data, snapshot),
      enumerable: false,
    },
  });
  return options;
}

/**
 * Run the pre-send `message:sending` plugin gate for one piece of outbound content and return the
 * (possibly plugin-modified) input, or throw `BadRequestException` when a plugin blocked it.
 *
 * Lives here rather than on a service so callers in different modules share one implementation.
 * A second copy of a moderation chokepoint is a chokepoint that will eventually disagree with itself.
 *
 * Current callers: `MessageSendService` (every sender), `MessageService` (edit), both reporting source
 * `'MessageService'`, `StatusService` (the three posts) and `CatalogService` (`sendProduct`).
 * `BulkMessageService` still runs its own inlined copy — it has to flag a plugin block separately
 * from a delivery failure so the per-item `message:failed` hook is skipped, which this signature
 * cannot express. If you change the gate's semantics here, change it there too
 * (`bulk-message.service.ts`, the `blockedByPlugin` branch).
 *
 * CONTRACT NOTE — the gate does NOT see every attempted send. When send pacing is enabled
 * (`SEND_PACING_ENABLED`), the pacing governor runs BEFORE this gate at every call site, so a send
 * it refuses fires no `message:sending` at all: a plugin cannot observe, moderate or rewrite traffic
 * that policy already forbids. A plugin treating this hook as a complete record of send ATTEMPTS
 * will therefore miss paced-out ones; it remains a complete record of sends that were actually
 * attempted against WhatsApp. Refusals surface to the client as `429` with `code:
 * SEND_PACING_LIMITED`, distinct from a plugin veto's `400`.
 *
 * `source` names the caller in the hook context so a plugin can tell a chat send from a status
 * post without inspecting the payload shape — which matters because the shapes differ: a
 * MessageService `input` is a send DTO carrying `chatId`, a StatusService `input` is not.
 *
 * Routing fields (`chatId`, `toChatId`, `fromChatId`, `quotedMessageId`, `messageId`) are pinned to
 * the caller's original pre-gate values after the hook returns (and removed if absent or `undefined`
 * on the caller's input). Both single sends and bulk items therefore always deliver to the caller's
 * original target while still allowing plugins to inspect routing fields and rewrite message content.
 */
export async function applySendingGate<T extends object>(
  hookManager: HookManager,
  sessionId: string,
  type: string,
  input: T,
  source: string,
): Promise<T> {
  const pinnedRouting = capturePinnedRouting(input);
  let gateOutcome: { continue: boolean; data: { sessionId: string; input: T; type: string } };
  try {
    gateOutcome = await hookManager.execute(
      'message:sending',
      { sessionId, input: cloneGateInput(input), type },
      buildSendingExecuteOptions(sessionId, source, pinnedRouting),
    );
  } catch (error) {
    if (error instanceof HookExecutionError) {
      logger.warn('Outbound send blocked: pre-egress message:sending hook failed in fail-closed mode', {
        pluginId: error.pluginId,
        event: error.event,
        sessionId,
        source,
        type,
        error: error.message,
      });
      throw markNothingSent(
        new ServiceUnavailableException('Message sending temporarily blocked: a required pre-send plugin hook failed'),
      );
    }
    throw error;
  }
  const { continue: shouldContinue, data: hookData } = gateOutcome;
  if (!shouldContinue) {
    throw new BadRequestException('Message sending blocked by plugin');
  }
  // Defensive, and unreachable through HookManager: `runHandlers` returns `{ continue: true, data }`
  // with the envelope it was given when no handler is registered, and only replaces it when a
  // handler returns `data !== undefined` — so neither the no-plugin path nor a handler that returns
  // nothing produces `undefined` here. It stays because "the manager returned no data" is not
  // evidence a plugin wanted this send stopped, so the safe reading is the caller's own input; the
  // fail-CLOSED rule below applies to a reply that IS present and cannot be read.
  if (hookData === undefined) {
    return input;
  }
  // Anything else must still be an envelope. Reading `.input` off it unchecked handed `undefined`
  // (or threw, for a null) to every caller, so one plugin authoring mistake turned every outbound
  // send on the session into an unhandled TypeError and a 500 that named no plugin.
  //
  // Fails CLOSED, deliberately: this is a moderation chokepoint, and a handler whose reply cannot be
  // read may have been redacting something — proceeding with the original input would turn a plugin
  // bug into a moderation bypass. Same status as a veto, because to the caller the outcome is the
  // same (a plugin stopped this send); the message names the hook so the operator can find it.
  const envelope = hookData as { input?: unknown } | null;
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    Array.isArray(envelope) ||
    typeof envelope.input !== 'object' ||
    envelope.input === null ||
    Array.isArray(envelope.input)
  ) {
    // The 400 reaches the API caller, who cannot fix a plugin. This refusal stops EVERY send on the
    // session, so the operator needs it in the server log — with the session and call site, since
    // the chain's aggregated reply does not say which handler produced it.
    logger.warn('A message:sending handler returned a payload without a usable `input`; refusing the send', {
      sessionId,
      source,
      type,
      received: hookData === null ? 'null' : typeof hookData,
    });
    throw new BadRequestException(
      'A message:sending handler returned a payload without a usable `input`; the send was refused rather than sent unmoderated',
    );
  }
  // Use the potentially plugin-modified content while stripping dangerous keys and pinning caller routing fields.
  return applyPinnedRouting(envelope.input as Record<string, unknown>, pinnedRouting) as T;
}
