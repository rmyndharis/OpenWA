import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { evaluatePreflight } from './ingress-preflight';
import type { IngressRouteDescriptor } from './ingress.service';

function route(response?: { preflight?: any[] }): IngressRouteDescriptor {
  return {
    route: 'r',
    mode: 'async',
    verify: 'core',
    maxBodyBytes: 1024,
    signature: { scheme: 'none' },
    response,
  } as unknown as IngressRouteDescriptor;
}

describe('evaluatePreflight', () => {
  it('passes (null) when no preflight is declared', () => {
    expect(evaluatePreflight(route(), 'sess-1', () => EngineStatus.READY)).toBeNull();
  });

  it('passes when the concrete session is READY', () => {
    expect(
      evaluatePreflight(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', () => EngineStatus.READY),
    ).toBeNull();
  });

  it('passes (accept-and-defer) for a recoverable status', () => {
    for (const s of [
      EngineStatus.INITIALIZING,
      EngineStatus.QR_READY,
      EngineStatus.AUTHENTICATING,
      EngineStatus.DISCONNECTED,
    ]) {
      expect(evaluatePreflight(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', () => s)).toBeNull();
    }
  });

  it('rejects with 503 when the concrete session is FAILED', () => {
    expect(
      evaluatePreflight(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', () => EngineStatus.FAILED),
    ).toEqual({
      status: 503,
      body: 'session not ready',
    });
  });

  it('rejects with 503 when there is no live engine (stopped/deleted)', () => {
    expect(evaluatePreflight(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', () => undefined)).toEqual({
      status: 503,
      body: 'session not ready',
    });
  });

  it('skips (passes) for a wildcard scope — no single session to probe', () => {
    expect(
      evaluatePreflight(route({ preflight: [{ type: 'session-alive' }] }), '*', () => EngineStatus.FAILED),
    ).toBeNull();
    expect(
      evaluatePreflight(route({ preflight: [{ type: 'session-alive' }] }), null, () => EngineStatus.FAILED),
    ).toBeNull();
  });

  it('skips (passes) when sessionStatus is unwired — pure tests must not false-reject', () => {
    expect(evaluatePreflight(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', undefined)).toBeNull();
  });
});
