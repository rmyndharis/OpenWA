import type { z } from 'zod';
import type { ApiKey } from '../../modules/auth/entities/api-key.entity';
import type { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';

/** A single agent-invocable capability. Protocol-neutral: no MCP types here. */
export interface ToolDescriptor<I = unknown> {
  /** Explicit, stable public name, e.g. 'MessageSendText'. */
  name: string;
  /** Agent-legible description: what it does, when to use it, preconditions. */
  description: string;
  /** Input contract: validates the call AND is advertised to the agent. */
  inputSchema: z.ZodType<I>;
  tier: 'read' | 'write';
  /** True for irreversible/dangerous ops (none are exposed in v1). */
  destructive?: boolean;
  /** Safe to repeat without additional effect. Defaults to (tier === 'read'). */
  idempotent?: boolean;
  /** Minimum role; checked via AuthService.hasPermission. */
  requiredRole?: ApiKeyRole;
  /** If true, input MUST carry `sessionId`, checked against the key's allowedSessions. */
  sessionScoped?: boolean;
  /** Result rendering hint for the MCP adapter. Default 'smart'. */
  resultDisposition?: 'json' | 'smart';
  /** Calls the service. Receives validated input + the resolved, scoped key. */
  handler: (input: I, apiKey: ApiKey) => Promise<unknown>;
}

/**
 * A descriptor with its input type erased, for storing tools of different shapes in one list.
 *
 * The handler parameter is `never`, not `unknown`. Under `strictFunctionTypes` parameters are checked
 * CONTRAVARIANTLY, so a handler that accepts a specific validated shape is assignable to one
 * accepting `never` but not to one accepting `unknown` — and `unknown` would be the wrong promise
 * anyway, since the registry cannot hand a handler just anything.
 *
 * What makes the erasure sound is the invoker: it parses `inputSchema` first, so a handler only ever
 * receives a value its own schema accepted. The one cast that bridges the two lives there, next to
 * the parse that justifies it, rather than being spread across every tool definition.
 */
export type AnyToolDescriptor = Omit<ToolDescriptor, 'inputSchema' | 'handler'> & {
  inputSchema: z.ZodType;
  handler: (input: never, apiKey: ApiKey) => Promise<unknown>;
};

/**
 * Declare one tool, tying its handler to its own schema.
 *
 * Annotating a list as `ToolDescriptor[]` cannot do this: it pins `I` to `unknown` for every entry,
 * so each tool's schema and handler are only ever checked against `unknown` and never against each
 * other. Inferring `I` per tool here means a handler that reads a field its schema does not declare
 * is a compile error, and the handler's parameter no longer has to be written out by hand — it is
 * whatever the schema produces, so the two cannot drift apart.
 */
export function defineTool<I>(descriptor: ToolDescriptor<I>): AnyToolDescriptor {
  return descriptor;
}
