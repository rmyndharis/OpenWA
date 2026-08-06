import { BadRequestException } from '@nestjs/common';
import { HookManager } from './hook-manager.service';

/**
 * Run the pre-send `message:sending` plugin gate for one piece of outbound content and return the
 * (possibly plugin-modified) input, or throw `BadRequestException` when a plugin blocked it.
 *
 * Lives here rather than on a service so callers in different modules share one implementation.
 * A second copy of a moderation chokepoint is a chokepoint that will eventually disagree with itself.
 *
 * Current callers: `MessageService` (all senders + edit) and `StatusService` (the three posts).
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
  // Use the potentially plugin-modified input.
  return (hookData as { input: T }).input;
}
