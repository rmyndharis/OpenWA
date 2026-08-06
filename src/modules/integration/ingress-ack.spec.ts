import { renderAck } from './ingress-ack';

const ctx = { rawBody: '{"a":1}', timestamp: '1700000000', id: 'd1' };

describe('renderAck', () => {
  it('returns the default 202 ack when no spec is declared', () => {
    expect(renderAck(undefined, ctx)).toEqual({ status: 202, body: 'accepted' });
  });

  it('renders a declared status and body verbatim', () => {
    expect(renderAck({ status: 200, body: '{"ok":true}' }, ctx)).toEqual({ status: 200, body: '{"ok":true}' });
  });

  it('substitutes {rawBody}/{timestamp}/{id} templates', () => {
    expect(renderAck({ body: 'echo:{rawBody}:{id}:{timestamp}' }, ctx).body).toBe('echo:{"a":1}:d1:1700000000');
  });

  it('passes through declared headers', () => {
    expect(renderAck({ headers: { 'content-type': 'application/json' } }, ctx).headers).toEqual({
      'content-type': 'application/json',
    });
  });

  it('substitutes literally even when rawBody contains $ characters (no regex/$ semantics)', () => {
    expect(renderAck({ body: '{rawBody}' }, { ...ctx, rawBody: '$&$`$1' }).body).toBe('$&$`$1');
  });

  it('omits body and headers when not declared', () => {
    expect(renderAck({ status: 204 }, ctx)).toEqual({ status: 204 });
  });
});
