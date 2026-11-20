import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const logger = createLogger('Mcp');

/**
 * The most a result may weigh, in UTF-8 bytes, and still be returned as text. The server has no `resources`
 * capability, so an offloaded result is only an embedded blob: Claude Code saves it to a file on its own
 * machine and tells the model just the path, so the model sees the data only if it has a file tool and a
 * client that forwards text alone shows none. An ordinary page of rows (a few dozen sessions, chats or
 * messages) therefore has to fit under this; only a payload past it is offloaded, to keep the context compact.
 * An operator who serves clients that cannot take a blob can set `MCP_MAX_RESULT_BYTES`, which turns the offload
 * off and returns every result as text, cut at that size (see {@link smartToolResult}); unset, this is all there is.
 */
export const INLINE_RESULT_MAX_BYTES = 32 * 1024;

/**
 * The opt-in cap on a result, from `MCP_MAX_RESULT_BYTES`: a positive decimal integer in UTF-8 bytes. Unset, blank,
 * `0` or anything else reads as 0, no cap, which is the behaviour before the knob existed. Boot validation rejects
 * a malformed value, so the lenient read only covers a process that skipped it. A count past what a number holds
 * exactly is still a cap, one no result reaches: read as no cap it would bring the base64 resource back.
 */
export function readMaxResultBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MCP_MAX_RESULT_BYTES']?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Math.min(Number(raw), Number.MAX_SAFE_INTEGER);
}

/** The end of the longest prefix of `bytes` that is at most `max` bytes and does not end inside a UTF-8 character. */
function utf8SafeEnd(bytes: Buffer, max: number): number {
  let end = max;
  // A continuation byte (10xxxxxx) at the cut means the character that owns it started before the cut.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * `text` whole when it fits `maxResultBytes`, else its longest prefix that does, never cut inside a character,
 * and a note with the full size and `advice`.
 */
function cutToCap(text: string, maxResultBytes: number, advice = ''): string {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= maxResultBytes) return text;
  const head = buffer.subarray(0, utf8SafeEnd(buffer, maxResultBytes)).toString('utf8');
  return `${head}\n…[truncated: ${buffer.byteLength} bytes in all${advice}]`;
}

/**
 * An error answer under the cap, which {@link smartToolResult} applies to the others. A refusal is short as a
 * rule, but one that lists each invalid value grows with the arguments sent: the SDK's own answer to arguments
 * its schema refuses, and a service's list of validation messages.
 */
export function capToolError(result: CallToolResult, maxResultBytes: number): CallToolResult {
  if (maxResultBytes <= 0) return result;
  return {
    ...result,
    content: result.content.map(item =>
      item.type === 'text' ? { ...item, text: cutToCap(item.text, maxResultBytes) } : item,
    ),
  };
}

/**
 * Format a tool result.
 *
 * With `maxResultBytes` above 0 (the operator's `MCP_MAX_RESULT_BYTES`), the result is always ONE text item, for the
 * clients that put a whole result in the model's context (claude.ai, ChatGPT) and fail past a size: a payload at or
 * under the cap whole, a larger one as its first `maxResultBytes` bytes, cut at a character boundary, and a note
 * with the full size. Nothing is offloaded, because the blob is the same data in base64: a third larger, so a
 * payload under the cap could still pass the size the cap was set for, and unreadable to a client that shows the
 * model text alone.
 *
 * Without a cap, a payload up to {@link INLINE_RESULT_MAX_BYTES} is inlined as text and a larger one is offloaded
 * to an embedded base64 resource so the response stays compact.
 */
export function smartToolResult(data: string | object | object[], maxResultBytes = 0): CallToolResult {
  // JSON.stringify(undefined) is undefined, not a string — a handler that resolves void would turn
  // a completed write into a thrown TypeError here, reported to the agent as a failure it retries.
  const text = typeof data === 'string' ? data : (JSON.stringify(data) ?? 'null');
  if (maxResultBytes > 0) {
    const advice = '; narrow the request, with limit and offset where the tool takes them, to see the rest';
    return { content: [{ type: 'text', text: cutToCap(text, maxResultBytes, advice) }] };
  }
  const mimeType = typeof data === 'string' ? 'text/plain' : 'application/json';
  const ext = typeof data === 'string' ? 'txt' : 'json';
  const buffer = Buffer.from(text);
  if (buffer.byteLength > INLINE_RESULT_MAX_BYTES) {
    const uri = `mcp://toolResult/${randomUUID()}.${ext}`;
    return {
      content: [
        { type: 'text', text: `Received resource ${uri} with ${buffer.byteLength} bytes` },
        { type: 'resource', resource: { uri, mimeType, blob: buffer.toString('base64') } },
      ],
    };
  }
  return { content: [{ type: 'text', text }] };
}

/** Format a tool result as compact JSON text. */
export function jsonToolResult(data: object, isError = false): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(data) }] };
  if (isError) {
    result.isError = true;
  }
  return result;
}

/**
 * The longest text a tool error carries, in UTF-16 code units. The services name a caller's id in their
 * refusals ("Webhook with id '...' not found", "... is not a group id", PostgreSQL's own "invalid input
 * syntax" for the value), so an id of megabytes came straight back in the answer and in the log line.
 * REST bounds an id by its request line; a tool call reads the whole body, up to BODY_SIZE_LIMIT.
 */
export const TOOL_ERROR_TEXT_MAX_CHARS = 4096;

/** A stack holds the frames a long message must not push out, so it is capped on its own, higher. */
const TOOL_ERROR_STACK_MAX_CHARS = 16384;

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  // Never leave half of a surrogate pair at the cut.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}... [truncated, ${text.length} characters in all]`;
}

/** The message as the answer carries it: a string, or each string of a list, cut at the cap. */
function clipMessage(message: unknown): unknown {
  if (typeof message === 'string') return clipText(message, TOOL_ERROR_TEXT_MAX_CHARS);
  if (Array.isArray(message)) {
    return message.map((part: unknown) =>
      typeof part === 'string' ? clipText(part, TOOL_ERROR_TEXT_MAX_CHARS) : part,
    );
  }
  return message;
}

/** The stack with the copy of a long message cut down, so the frames survive, and capped whole as a last resort. */
function clipStack(error: Error): string | undefined {
  const { stack } = error;
  // An error built by a library can carry either as anything; this handler must still answer, and log.
  if (typeof stack !== 'string') return undefined;
  const message = String(error.message);
  // A replacer function: the cut message may hold `$&` or `$1`, which a replacement string would expand.
  const shortened =
    message.length > TOOL_ERROR_TEXT_MAX_CHARS
      ? stack.replace(message, () => clipText(message, TOOL_ERROR_TEXT_MAX_CHARS))
      : stack;
  return clipText(shortened, TOOL_ERROR_STACK_MAX_CHARS);
}

/**
 * Map a thrown error to a tool-error result. Stack traces and raw thrown values
 * are logged server-side only — never put on the wire, where they would leak
 * server internals to the MCP client.
 *
 * HttpExceptions carry client-safe messages (they mirror REST error responses).
 * All other errors get a generic wire message to avoid leaking internals.
 *
 * The text that reaches the answer and the log is cut at {@link TOOL_ERROR_TEXT_MAX_CHARS}: a refusal
 * that names an id the caller sent would otherwise carry the whole id back.
 */
export function handleToolError(error: unknown): CallToolResult {
  if (error instanceof HttpException) {
    // A 4xx is the client's mistake (unknown session, bad input, missing role), which REST does not
    // log at all: a warn line without a stack, so error-level alerting fires on server faults only.
    const text = clipText(String(error.message), TOOL_ERROR_TEXT_MAX_CHARS);
    if (error.getStatus() >= 500) logger.error(text, clipStack(error));
    else logger.warn(`MCP tool error ${error.getStatus()}: ${text}`);
    const res = error.getResponse();
    const body = typeof res === 'object' && res !== null ? (res as Record<string, unknown>) : undefined;
    const message = clipMessage(body && 'message' in body ? body['message'] : error.message);
    // The machine-readable code a REST answer carries (IDEMPOTENCY_KEY_IN_PROGRESS), which an agent branches on.
    // Bounded like the message: it is a short token in every exception that sets one.
    const code = typeof body?.['code'] === 'string' ? body['code'].slice(0, 64) : undefined;
    // The interval a REST answer names for a retry (the page reload 409, the send pacing 429): how long to wait.
    const wait = body?.['retryAfterSeconds'];
    const retryAfterSeconds = typeof wait === 'number' && Number.isFinite(wait) && wait >= 0 ? wait : undefined;
    return jsonToolResult(
      {
        success: false,
        name: error.name,
        message,
        ...(code ? { code } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
      true,
    );
  }
  if (error instanceof Error) {
    logger.error(clipText(String(error.message), TOOL_ERROR_TEXT_MAX_CHARS), clipStack(error));
    return jsonToolResult({ success: false, name: error.name, message: 'Internal error' }, true);
  }
  logger.error('Unknown tool error', clipText(String(error), TOOL_ERROR_STACK_MAX_CHARS));
  return jsonToolResult({ success: false, name: 'Unknown error', message: 'Internal error' }, true);
}
