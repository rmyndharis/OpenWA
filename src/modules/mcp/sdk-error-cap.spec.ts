import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capSdkErrors } from './mcp.server';

// The real SDK classes, linked in memory: mcp.server.spec.ts mocks McpServer, and what is pinned here is a
// method private to the SDK. A release that renames it leaves the refusal below uncut and fails this file.

const CAP = 1000;
const INVALID_ENTRIES = 500;

/** Calls a tool with a map whose every value the schema refuses, so the SDK answers before any callback runs. */
async function refusedCall(maxResultBytes: number): Promise<{ isError: boolean; text: string }> {
  const server = new McpServer({ name: 'spec', version: '0.0.0' }, { capabilities: { tools: {} } });
  capSdkErrors(server, maxResultBytes);
  const callback = jest.fn(() => ({ content: [] }));
  server.registerTool('Echo', { inputSchema: z.strictObject({ vars: z.record(z.string(), z.string()) }) }, callback);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spec-client', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const vars = Object.fromEntries(Array.from({ length: INVALID_ENTRIES }, (_, i) => [`v${i}`, 1]));
    const result = await client.callTool({ name: 'Echo', arguments: { vars } });
    expect(callback).not.toHaveBeenCalled();
    const content = result.content as Array<{ type: string; text?: string }>;
    return { isError: result.isError === true, text: content[0]?.text ?? '' };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('capSdkErrors (the answers the SDK writes itself)', () => {
  it('leaves a refusal of invalid arguments whole without a cap, one line per bad value', async () => {
    const { isError, text } = await refusedCall(0);
    expect(isError).toBe(true);
    expect(text).toContain('Invalid arguments for tool Echo');
    expect(text).not.toContain('[truncated:');
    // The control for the next test: uncut, this answer is several times the cap used there.
    expect(Buffer.byteLength(text)).toBeGreaterThan(CAP * 5);
  });

  it('cuts that refusal at the cap and says how long it was', async () => {
    const { isError, text } = await refusedCall(CAP);
    expect(isError).toBe(true);
    const [head, note] = text.split('\n…');
    expect(Buffer.byteLength(head)).toBeLessThanOrEqual(CAP);
    expect(head).toContain('Invalid arguments for tool Echo');
    expect(note).toMatch(/^\[truncated: \d+ bytes in all\]$/);
  });
});
