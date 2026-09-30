import { BadRequestException } from '@nestjs/common';
import { HookManager } from './hook-manager.service';
import { createLogger } from '../../common/services/logger.service';

const logger = createLogger('SendingGate');

/**
 * Run the pre-send `message:sending` plugin gate for one piece of outbound content and return the
 * (possibly plugin-modified) input, or throw `BadRequestException` when a plugin blocked it.
 *
 * Lives here rather than on a service so callers in different modules share one implementation.
 * A second copy of a moderation chokepoint is a chokepoint that will eventually disagree with itself.
 *
 * Current callers: `MessageService` (all senders + edit), `StatusService` (the three posts) and
 * `CatalogService` (`sendProduct`, which ignores a rewritten `chatId` as bulk does).
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
 * A bulk item's `message:sending` and `message:failed` input carries that item's recipient `chatId`
 * as well, so a plugin reads the recipient of a bulk item the same way as a single send's. The
 * difference is on the way back: a single send goes to whatever `chatId` the gate returns, while a
 * `chatId` rewritten by the gate is ignored for a bulk item, which is always sent to its own recipient.
 */
export async function applySendingGate<T extends object>(
  hookManager: HookManager,
  sessionId: string,
  type: string,
  input: T,
  source: string,
): Promise<T> {
  const { continue: shouldContinue, data: hookData } = await hookManager.execute(
    'message:sending',
    { sessionId, input, type },
    { sessionId, source },
  );
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
    typeof envelope.input !== 'object' ||
    envelope.input === null
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
  // Use the potentially plugin-modified input.
  return envelope.input as T;
}
