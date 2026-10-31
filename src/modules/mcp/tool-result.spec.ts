import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { LoggerService } from '../../common/services/logger.service';
import { handleToolError, smartToolResult } from './tool-result';

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

  // The threshold is 4 KB of UTF-8, not 4096 UTF-16 code units: multi-byte text must not inline at triple size.
  it.each(['x'.repeat(4096), '\u00e9'.repeat(2048), '\ud83d\ude00'.repeat(1024)])(
    'inlines a payload of exactly 4096 UTF-8 bytes',
    text => {
      expect(smartToolResult(text).content).toEqual([{ type: 'text', text }]);
    },
  );

  it.each(['x'.repeat(4097), '\u00e9'.repeat(2048) + 'x', '\u4e2d'.repeat(2000), '\ud83d\ude00'.repeat(1025)])(
    'embeds a payload over 4096 UTF-8 bytes without changing its contents',
    text => {
      const { content } = smartToolResult(text);
      expect(content).toHaveLength(2);
      const resource = content[1];
      if (resource.type !== 'resource' || !('blob' in resource.resource)) throw new Error('expected a blob resource');
      expect(Buffer.from(resource.resource.blob, 'base64').toString('utf8')).toBe(text);
    },
  );

  it('offloads a payload over 4 KB to an embedded resource', () => {
    const big = { blob: 'x'.repeat(5000) };
    const result = smartToolResult(big);
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect(result.content[1]).toMatchObject({ type: 'resource', resource: { mimeType: 'application/json' } });
  });
});

describe('handleToolError logging', () => {
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs a client-caused 4xx at warn without a stack, as REST leaves it unlogged', () => {
    handleToolError(new NotFoundException('Session x not found'));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('MCP tool error 404: Session x not found');
  });

  it('keeps a 5xx at error with its stack', () => {
    const failure = new ServiceUnavailableException('engine down');
    handleToolError(failure);
    expect(error).toHaveBeenCalledWith('engine down', failure.stack);
    expect(warn).not.toHaveBeenCalled();
  });
});
