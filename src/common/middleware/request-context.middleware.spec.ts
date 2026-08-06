import { requestContextMiddleware } from './request-context.middleware';
import { getRequestId } from '../services/request-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeReqRes(headers: Record<string, string> = {}) {
  const req = { header: (name: string) => headers[name.toLowerCase()] };
  const setHeaders: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string) => void (setHeaders[name] = value) };
  return { req, res, setHeaders };
}

describe('requestContextMiddleware', () => {
  it('generates a UUID when no X-Request-ID header is supplied', () => {
    const { req, res, setHeaders } = makeReqRes();
    requestContextMiddleware(req as never, res as never, () => undefined);
    expect(setHeaders['X-Request-ID']).toMatch(UUID_RE);
  });

  it('echoes a valid client-supplied X-Request-ID', () => {
    const { req, res, setHeaders } = makeReqRes({ 'x-request-id': 'trace-abc-123' });
    requestContextMiddleware(req as never, res as never, () => undefined);
    expect(setHeaders['X-Request-ID']).toBe('trace-abc-123');
  });

  it('replaces an invalid X-Request-ID (CRLF injection attempt) with a generated UUID', () => {
    const { req, res, setHeaders } = makeReqRes({ 'x-request-id': 'bad\r\nInject: yes' });
    requestContextMiddleware(req as never, res as never, () => undefined);
    expect(setHeaders['X-Request-ID']).not.toContain('\r');
    expect(setHeaders['X-Request-ID']).toMatch(UUID_RE);
  });

  it('runs downstream next() inside the request scope (getRequestId resolves the id)', () => {
    const { req, res } = makeReqRes({ 'x-request-id': 'trace-xyz' });
    let seen: string | undefined;
    requestContextMiddleware(req as never, res as never, () => void (seen = getRequestId()));
    expect(seen).toBe('trace-xyz');
  });

  it('clears the request scope after next() returns (no leak across requests)', () => {
    const { req, res } = makeReqRes({ 'x-request-id': 'trace-xyz' });
    requestContextMiddleware(req as never, res as never, () => undefined);
    expect(getRequestId()).toBeUndefined();
  });
});
