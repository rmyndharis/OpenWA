import { randomUUID } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const logger = new Logger('Mcp');

/**
 * Format a tool result, inlining small payloads as text and offloading large
 * ones (> 4 KB) to an embedded base64 resource so the response stays compact.
 */
export function smartToolResult(data: string | object | object[]): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const mimeType = typeof data === 'string' ? 'text/plain' : 'application/json';
  const ext = typeof data === 'string' ? 'txt' : 'json';
  if (text.length > 4096) {
    const uri = `mcp://toolResult/${randomUUID()}.${ext}`;
    const buffer = Buffer.from(text);
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
 * Map a thrown error to a tool-error result. Stack traces and raw thrown values
 * are logged server-side only — never put on the wire, where they would leak
 * server internals to the MCP client.
 *
 * HttpExceptions carry client-safe messages (they mirror REST error responses).
 * All other errors get a generic wire message to avoid leaking internals.
 */
export function handleToolError(error: unknown): CallToolResult {
  if (error instanceof HttpException) {
    logger.error(error.message, error.stack);
    const res = error.getResponse();
    const message =
      typeof res === 'object' && res !== null && 'message' in res
        ? (res as Record<string, unknown>)['message']
        : error.message;
    return jsonToolResult({ success: false, name: error.name, message }, true);
  }
  if (error instanceof Error) {
    logger.error(error.message, error.stack);
    return jsonToolResult({ success: false, name: error.name, message: 'Internal error' }, true);
  }
  logger.error('Unknown tool error', String(error));
  return jsonToolResult({ success: false, name: 'Unknown error', message: 'Internal error' }, true);
}
