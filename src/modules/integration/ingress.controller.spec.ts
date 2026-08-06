import type { Request, Response } from 'express';
import { IngressController } from './ingress.controller';
import { IngressService } from './ingress.service';

// A byte sequence whose JSON.stringify(parse(x)) would NOT round-trip identically: extra whitespace,
// key order, and a trailing newline. The controller must forward the RAW bytes, not a re-serialized body.
const RAW = '{\n  "event": "message_created",\n  "id": 42\n}\n';

function fakeRes() {
  const captured: { status?: number; body?: string; headers?: Record<string, string> } = {};
  const res = {
    status: jest.fn((code: number) => {
      captured.status = code;
      return res;
    }),
    send: jest.fn((body: string) => {
      captured.body = body;
      return res;
    }),
    set: jest.fn((headers: Record<string, string>) => {
      captured.headers = headers;
      return res;
    }),
  } as unknown as Response;
  return { res, captured };
}

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
});
