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
