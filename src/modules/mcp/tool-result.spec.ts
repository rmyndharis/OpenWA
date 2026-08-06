import { smartToolResult } from './tool-result';

describe('smartToolResult', () => {
  it('inlines a small object as JSON text', () => {
    expect(smartToolResult({ id: 1 }).content).toEqual([{ type: 'text', text: '{"id":1}' }]);
  });

  it('passes a string payload through as plain text', () => {
    expect(smartToolResult('done').content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('survives an undefined handler result instead of throwing after the write ran', () => {
    // JSON.stringify(undefined) is undefined; reading .length off it threw a TypeError that
    // handleToolError then reported as `Internal error` for an operation that had succeeded.
    const result = smartToolResult(undefined as unknown as object);
    expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
  });

  it('offloads a payload over 4 KB to an embedded resource', () => {
    const big = { blob: 'x'.repeat(5000) };
    const result = smartToolResult(big);
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect(result.content[1]).toMatchObject({ type: 'resource', resource: { mimeType: 'application/json' } });
  });
});
