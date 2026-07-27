import { ServiceUnavailableException } from '@nestjs/common';
import { EngineTransportError } from './engine-transport.error';

// A dead engine transport (crashed Chromium page, dropped WebSocket) surfaced as a generic Error
// becomes HTTP 500, and folded into a broad catch it becomes a false 404/400. EngineTransportError
// extends ServiceUnavailableException so NestJS maps it to 503 through the built-in handler (no
// global filter) — same mapping discipline as EngineRefusedError (403).
describe('EngineTransportError', () => {
  it('is a ServiceUnavailableException -> HTTP 503 without a custom global filter', () => {
    const err = new EngineTransportError('Protocol error: Target closed');
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getStatus()).toBe(503);
  });

  it('carries the transport detail as the message', () => {
    expect(new EngineTransportError('Connection Closed').message).toBe('Connection Closed');
  });
});
