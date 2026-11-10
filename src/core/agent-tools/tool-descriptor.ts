import { z } from 'zod';
import type { ApiKey } from '../../modules/auth/entities/api-key.entity';
import type { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
import type { ChatScopeService } from '../../modules/auth/chat-scope.service';

/** A single agent-invocable capability. Protocol-neutral: no MCP types here. */
export interface ToolDescriptor<I = unknown> {
  /** Explicit, stable public name, e.g. 'MessageSendText'. */
  name: string;
  /** Agent-legible description: what it does, when to use it, preconditions. */
  description: string;
  /** Input contract: validates the call AND is advertised to the agent. */
  inputSchema: z.ZodType<I>;
  tier: 'read' | 'write';
  /** True for irreversible or state-overwriting ops; surfaced to MCP clients as destructiveHint. */
  destructive?: boolean;
  /** Safe to repeat without additional effect. Defaults to (tier === 'read'). */
  idempotent?: boolean;
  /** Minimum role; checked via AuthService.hasPermission. */
  requiredRole?: ApiKeyRole;
  /** If true, input MUST carry `sessionId`, checked against the key's allowedSessions. */
  sessionScoped?: boolean;
  /** Allowed chat input fields, a filtered list, or a chat-independent operation. Unmarked tools deny restricted keys. */
  chatScope?: readonly string[] | 'filtered' | 'agnostic';
  /** The quote resolves within the authorized chat, as it does on the REST reply route. */
  chatQuotedAllowed?: boolean;
  /** Calls the service. Receives validated input + the resolved, scoped key. */
  handler: (input: I, apiKey: ApiKey, chatScope?: ChatScopeService, signal?: AbortSignal) => Promise<unknown>;
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
  handler: (input: never, apiKey: ApiKey, chatScope?: ChatScopeService, signal?: AbortSignal) => Promise<unknown>;
};

/** How many unrecognized argument names an error lists, and how much of each. */
const UNKNOWN_KEYS_SHOWN = 5;
const UNKNOWN_KEY_MAX_CHARS = 64;

/**
 * The error for arguments a tool does not name. The default message lists every one in full, and the transport
 * answers with it before the tool runs, so a caller who sends a megabyte of names would get a megabyte back.
 */
function unknownKeysMessage(keys: readonly string[]): string {
  const shown = keys
    .slice(0, UNKNOWN_KEYS_SHOWN)
    .map(key => JSON.stringify(key.length > UNKNOWN_KEY_MAX_CHARS ? `${key.slice(0, UNKNOWN_KEY_MAX_CHARS)}...` : key));
  const more = keys.length > shown.length ? ` (and ${keys.length - shown.length} more)` : '';
  return `Unrecognized key${keys.length === 1 ? '' : 's'}: ${shown.join(', ')}${more}`;
}

/** The schema-level error map of a strict object. The def types it for an issue of `never`, hence the cast. */
const unknownKeysError = ((issue: { code: string; keys?: string[] }) =>
  issue.code === 'unrecognized_keys' && issue.keys
    ? unknownKeysMessage(issue.keys)
    : undefined) as unknown as z.core.$ZodErrorMap<never>;

/**
 * Make an input object refuse arguments it does not name, as REST refuses a body property its DTO does not
 * declare. A tool call that carried one used to run with it silently dropped: a misspelled `quotedMessageId`
 * sent the message unquoted, a misspelled filter listed everything. The published schema then says
 * `additionalProperties: false`, so a client knows before it calls. Object-level checks are kept.
 * defineTool applies it to every input; a nested object that is not a whole input applies it itself.
 */
export function refuseUnknownArguments<S extends z.ZodType>(schema: S): S {
  if (!(schema instanceof z.ZodObject)) return schema;
  const object: z.ZodObject = schema;
  return object.clone({ ...object.def, catchall: z.never(), error: unknownKeysError }) as unknown as S;
}

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
  return { ...descriptor, inputSchema: refuseUnknownArguments(descriptor.inputSchema) };
}
