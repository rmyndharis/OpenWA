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
