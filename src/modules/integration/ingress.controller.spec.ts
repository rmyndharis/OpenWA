import type { Request, Response } from 'express';
import { IngressController } from './ingress.controller';
import { IngressService } from './ingress.service';

// A byte sequence whose JSON.stringify(parse(x)) would NOT round-trip identically: extra whitespace,
// key order, and a trailing newline. The controller must forward the RAW bytes, not a re-serialized body.
const RAW = '{\n  "event": "message_created",\n  "id": 42\n}\n';

// Models Express's header precedence: set() and type() write the same Content-Type slot, so the LAST
// writer wins. Recording them in separate fields hid the override, which let one test assert a declared
// application/json and another the forced text/plain with neither noticing they contradicted.
function fakeRes() {
  const headers: Record<string, string> = {};
  const captured: { status?: number; body?: string; headers: Record<string, string> } = { headers };
  const type = jest.fn((contentType: string) => {
    headers['content-type'] = contentType;
    return res;
  });
  const res = {
    type,
    status: jest.fn((code: number) => {
      captured.status = code;
      return res;
    }),
    send: jest.fn((body: string) => {
      captured.body = body;
      return res;
    }),
    set: jest.fn((incoming: Record<string, string>) => {
      for (const [name, value] of Object.entries(incoming)) headers[name.toLowerCase()] = value;
      return res;
    }),
  } as unknown as Response;
  return { res, captured };
}

// Both reflections echo provider-controlled strings; Express types a bare send() as text/html,
// which would make the echo XSS material on this origin. The route must force text/plain.
describe('reflection content type', () => {
  it('answers with Content-Type text/plain, never the Express default text/html', async () => {
    const handle = jest.fn().mockResolvedValue({ status: 200, body: '<script>alert(1)</script>' });
    const controller = new IngressController({ handle } as unknown as IngressService);
    const { res, captured } = fakeRes();
    const req = {
      method: 'POST',
      params: { path: ['chatwoot'] },
      headers: { 'x-delivery': 'd1', 'content-type': 'application/json' },
      rawBody: Buffer.from('{}', 'utf8'),
    } as unknown as Request & { rawBody?: Buffer };

    await controller.receive('chatwoot', 'acct1', {}, req, res);

    expect(captured.headers['content-type']).toBe('text/plain');
  });

  it('forces text/plain over a declared type a browser would execute', async () => {
    const handle = jest.fn().mockResolvedValue({
      status: 200,
      body: '<script>alert(1)</script>',
      headers: { 'content-type': 'text/html' },
    });
    const controller = new IngressController({ handle } as unknown as IngressService);
    const { res, captured } = fakeRes();
    const req = {
      method: 'POST',
      params: { path: ['send-sms'] },
      headers: { 'x-delivery': 'd1' },
      rawBody: Buffer.from('{}', 'utf8'),
    } as unknown as Request & { rawBody?: Buffer };

    await controller.receive('p', 'i1', {}, req, res);

    expect(captured.headers['content-type']).toBe('text/plain');
  });

  it('emits a declared application/json, which a provider may require on a 200', async () => {
    const handle = jest.fn().mockResolvedValue({
      status: 200,
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    });
    const controller = new IngressController({ handle } as unknown as IngressService);
    const { res, captured } = fakeRes();
    const req = {
      method: 'POST',
      params: { path: ['send-sms'] },
      headers: { 'x-delivery': 'd1' },
      rawBody: Buffer.from('{}', 'utf8'),
    } as unknown as Request & { rawBody?: Buffer };

    await controller.receive('p', 'i1', {}, req, res);

    expect(captured.headers['content-type']).toBe('application/json');
  });
});

describe('IngressController', () => {
  it('forwards the RAW request bytes byte-identically to the pipeline', async () => {
    const handle = jest.fn().mockResolvedValue({ status: 202, body: 'accepted' });
    const controller = new IngressController({ handle } as unknown as IngressService);

    const { res, captured } = fakeRes();
    const req = {
      method: 'POST',
      params: { path: ['chatwoot'] },
      headers: { 'x-delivery': 'd1', 'content-type': 'application/json' },
      rawBody: Buffer.from(RAW, 'utf8'),
    } as unknown as Request & { rawBody?: Buffer };

    await controller.receive('chatwoot', 'acct1', {}, req, res);

    expect(handle).toHaveBeenCalledTimes(1);
    const arg = (handle.mock.calls[0] as [{ rawBody: string; route: string; method: string }])[0];
    // Byte-for-byte identical to what the provider signed — no JSON round-trip.
    expect(arg.rawBody).toBe(RAW);
    expect(arg.route).toBe('chatwoot');
    expect(arg.method).toBe('POST');
    expect(captured.status).toBe(202);
    expect(captured.body).toBe('accepted');
  });

  it('lower-cases headers and tolerates an absent rawBody (empty string)', async () => {
    const handle = jest.fn().mockResolvedValue({ status: 200, body: '' });
    const controller = new IngressController({ handle } as unknown as IngressService);

    const { res } = fakeRes();
    const req = {
      method: 'GET',
      params: { path: ['meta', 'webhook'] },
      headers: { 'X-Verify-Token': 'vtok' },
    } as unknown as Request & { rawBody?: Buffer };

    await controller.receive('meta', 'acct1', { 'hub.challenge': '1' }, req, res);

    const arg = (handle.mock.calls[0] as [{ headers: Record<string, string>; route: string; rawBody: string }])[0];
    // Header keys lower-cased; multi-segment splat reduced to the first route segment.
    expect(arg.headers['x-verify-token']).toBe('vtok');
    expect(arg.route).toBe('meta');
    expect(arg.rawBody).toBe('');
  });

  it('forwards response headers from the pipeline', async () => {
    const handle = jest.fn().mockResolvedValue({
      status: 200,
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    });
    const controller = new IngressController({ handle } as unknown as IngressService);
    const { res, captured } = fakeRes();
    const req = {
      method: 'POST',
      params: { path: ['send-sms'] },
      headers: { 'x-delivery': 'd1' },
      rawBody: Buffer.from('{}'),
    } as unknown as Request & { rawBody?: Buffer };
    await controller.receive('p', 'i1', {}, req, res);
    expect(captured.status).toBe(200);
    expect(captured.body).toBe('{"ok":true}');
    expect(captured.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('never writes a reserved header a route declared', async () => {
    // res.type rewrites content-type whatever happens, so asserting that header alone cannot tell
    // whether the filter runs at all. These are the ones nothing downstream would put back.
    const handle = jest.fn().mockResolvedValue({
      status: 200,
      body: 'ok',
      headers: { 'Set-Cookie': 'a=b', 'Transfer-Encoding': 'chunked', 'X-Provider-Ack': 'kept' },
    });
    const controller = new IngressController({ handle } as unknown as IngressService);
    const { res, captured } = fakeRes();
    const req = {
      method: 'POST',
      params: { path: ['send-sms'] },
      headers: {},
      rawBody: Buffer.from('{}'),
    } as unknown as Request & { rawBody?: Buffer };

    await controller.receive('p', 'i1', {}, req, res);

    expect(captured.headers['set-cookie']).toBeUndefined();
    expect(captured.headers['transfer-encoding']).toBeUndefined();
    expect(captured.headers['x-provider-ack']).toBe('kept');
  });
});

describe('query values reach the pipeline as strings', () => {
  const callWithQuery = async (query: Record<string, unknown>) => {
    const handle = jest.fn().mockResolvedValue({ status: 200, body: '' });
    const controller = new IngressController({ handle } as unknown as IngressService);
    const { res } = fakeRes();
    const req = {
      method: 'GET',
      params: { path: ['meta'] },
      headers: {},
    } as unknown as Request & { rawBody?: Buffer };
    await controller.receive('meta', 'i1', query as Record<string, string>, req, res);
    return (handle.mock.calls[0] as [{ query: Record<string, string> }])[0].query;
  };

  it('keeps the first value of a repeated parameter', async () => {
    // Express answers `?hub.challenge=a&hub.challenge=b` with an array, and the challenge path feeds
    // the value into a constant-time compare that accepts only strings, so this used to answer 500.
    const query = await callWithQuery({ 'hub.challenge': ['a', 'b'], 'hub.verify_token': 'tok' });
    expect(query).toEqual({ 'hub.challenge': 'a', 'hub.verify_token': 'tok' });
    for (const value of Object.values(query)) expect(typeof value).toBe('string');
  });

  it('answers an empty string for a repeated parameter with no values, and for a non-string one', async () => {
    const query = await callWithQuery({ empty: [], odd: { nested: 'x' } });
    expect(query).toEqual({ empty: '', odd: '' });
  });
});
