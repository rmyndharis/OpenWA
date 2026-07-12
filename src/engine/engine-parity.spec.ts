import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { ENGINE_CAPABILITY_MATRIX } from './engine-capability-matrix';

/**
 * Drift invariants for the engine capability matrix. The matrix's `status` (supported /
 * not-available) is hand-curated and richer than a throw-scan: it also marks "phantom support"
 * methods (adapter stubs that return null/[] without throwing — see docs/engine-capability-matrix.md).
 * So the gate asserts the invariants a throw-scan CAN verify, not full equality:
 *
 *   1. A method whose adapter body throws EngineNotSupportedError/ChannelMediaNotSupportedError
 *      MUST be `not-available` in the matrix (throws always mean unavailable).
 *   2. A method the matrix marks `supported` MUST NOT throw.
 *
 * The allowed gap (not deliberate drift): a method that is `not-available` but does not throw today
 * — a phantom stub. Those are hand-tracked in the matrix; a throw-scan cannot see them. If an adapter
 * method starts or stops throwing, one of the invariants trips and forces a deliberate matrix update.
 *
 * No engine is instantiated and no Chromium/socket is opened: it reads method bodies via
 * `Class.prototype.method.toString()`, a fast hermetic structural check.
 */
const UNSUPPORTED_RE = /this\.unsupported\(|EngineNotSupportedError|ChannelMediaNotSupportedError/;

function readInterfaceMethods(): string[] {
  const src = readFileSync(join(__dirname, 'interfaces', 'whatsapp-engine.interface.ts'), 'utf8');
  const names = new Set<string>();
  for (const line of src.split('\n')) {
    const match = line.match(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*\(/);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

type AdapterCtor = { prototype: Record<string, unknown> };
type AdapterKey = 'wwjs' | 'baileys';
const ADAPTERS: ReadonlyArray<[AdapterKey, AdapterCtor]> = [
  ['wwjs', WhatsAppWebJsAdapter as unknown as AdapterCtor],
  ['baileys', BaileysAdapter as unknown as AdapterCtor],
];

function liveThrows(adapter: AdapterCtor, method: string): boolean {
  const fn = adapter.prototype[method];
  if (typeof fn !== 'function') return true; // missing method = effectively unavailable
  return UNSUPPORTED_RE.test(String(fn));
}

describe('engine capability matrix — drift invariants', () => {
  const methods = readInterfaceMethods();
  const matrixKeys = Object.keys(ENGINE_CAPABILITY_MATRIX).sort();

  it('matrix keys exactly match the interface methods (no missing, no stale)', () => {
    const missing = methods.filter(m => !(m in ENGINE_CAPABILITY_MATRIX));
    const stale = matrixKeys.filter(k => !methods.includes(k));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it.each(methods)('%s: throws ⇒ not-available, supported ⇒ not-throws', method => {
    const entry = ENGINE_CAPABILITY_MATRIX[method];
    for (const [adapter, ctor] of ADAPTERS) {
      const throws = liveThrows(ctor, method);
      const status = entry[adapter].status;
      if (throws) {
        expect({ method, adapter, status }).toEqual({ method, adapter, status: 'not-available' });
      }
      if (status === 'supported') {
        expect({ method, adapter, throws }).toEqual({ method, adapter, throws: false });
      }
    }
  });
});
