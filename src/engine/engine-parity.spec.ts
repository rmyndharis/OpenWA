import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { ENGINE_CAPABILITY_MATRIX } from './engine-capability-matrix';

/**
 * Drift invariants for the engine capability matrix. Status and throw behaviour must agree exactly:
 * a cell is `not-available` if and only if the adapter method throws
 * EngineNotSupportedError/ChannelMediaNotSupportedError.
 *
 * The reverse direction — `not-available` implies throws — is the one that catches a "phantom
 * support" stub: an adapter method that returns null/[] for a capability it cannot deliver, so a
 * caller reads an empty result as an answer instead of the 501 it should get. Those stubs are what
 * docs/29-engine-capability-matrix.md's "0 phantom-support rows" asserts, and until this direction
 * was checked, that claim was true only by inspection — a cell could be marked `not-available`,
 * quietly stop throwing, and nothing would go red.
 *
 * Both directions now trip on any change, forcing a deliberate matrix update.
 *
 * No engine is instantiated and no Chromium/socket is opened: it reads method bodies via
 * `Class.prototype.method.toString()`, a fast hermetic structural check.
 */
const UNSUPPORTED_RE = /this\.unsupported\(|EngineNotSupportedError|ChannelMediaNotSupportedError/;

/** A member declaration, optional or not. `\??` is load-bearing — see the test below. */
const MEMBER_RE = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??\s*\(/;

function readInterfaceMethods(): string[] {
  const src = readFileSync(join(__dirname, 'interfaces', 'whatsapp-engine.interface.ts'), 'utf8');
  const names = new Set<string>();
  for (const line of src.split('\n')) {
    const match = line.match(MEMBER_RE);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

describe('the interface reader sees every member', () => {
  // An optional member is still a member. Before `\??` was added, `probeLiveness?()` did not match
  // here, so the matrix could omit it and this whole file reported green while doing so — every
  // optional method added to IWhatsAppEngine would have had a permanent free pass.
  it('matches an optional declaration as well as a required one', () => {
    expect('  probeLiveness?(): Promise<boolean>;'.match(MEMBER_RE)?.[1]).toBe('probeLiveness');
    expect('  getStatus(): SessionStatus;'.match(MEMBER_RE)?.[1]).toBe('getStatus');
    // And still rejects what it should: a nested member, and a property that is not a call.
    expect('    nested(): void;'.match(MEMBER_RE)).toBeNull();
    expect('  someProperty: string;'.match(MEMBER_RE)).toBeNull();
  });
});

type AdapterCtor = { prototype: Record<string, unknown> };
type AdapterKey = 'wwjs' | 'baileys';
const ADAPTERS: ReadonlyArray<[AdapterKey, AdapterCtor]> = [
  ['wwjs', WhatsAppWebJsAdapter as unknown as AdapterCtor],
  ['baileys', BaileysAdapter as unknown as AdapterCtor],
];

/**
 * Unsupported-throws that live in DELEGATE modules rather than in the adapter prototype.
 *
 * The prototype scan reads a method's own body text, so once an adapter method forwards to a
 * delegate its `EngineNotSupportedError` becomes invisible and BOTH invariants stop applying to it:
 * a genuinely unsupported method could be marked `supported` and the gate would say nothing. That is
 * not hypothetical — every wwjs unsupported-throw except a handful now lives in a `wwebjs-*` module.
 *
 * Every throw site names its own method as a string literal, so the registry is derived from those
 * literals instead of by following delegation, which would mean resolving call graphs in a spec.
 * Bucketed by filename because that is what identifies the engine: `baileys*` is Baileys, the wwjs
 * adapter and its `wwebjs-*` delegates are wwjs.
 */
function readDelegateThrows(): Record<string, Set<string>> {
  const dir = join(__dirname, 'adapters');
  const registry: Record<string, Set<string>> = { wwjs: new Set(), baileys: new Set() };
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
    const engine = file.startsWith('baileys') ? 'baileys' : 'wwjs';
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/(?:new EngineNotSupportedError|this\.unsupported)\(\s*'([a-zA-Z][a-zA-Z0-9]*)'/g)) {
      registry[engine].add(m[1]);
    }
  }
  return registry;
}

const DELEGATE_THROWS = readDelegateThrows();

function liveThrows(adapter: AdapterCtor, method: string, engine: string): boolean {
  if (DELEGATE_THROWS[engine].has(method)) return true;
  const fn = adapter.prototype[method];
  if (typeof fn !== 'function') return true; // missing method = effectively unavailable
  return UNSUPPORTED_RE.test(String(fn));
}

describe('engine capability matrix — drift invariants', () => {
  const methods = readInterfaceMethods();
  const matrixKeys = Object.keys(ENGINE_CAPABILITY_MATRIX).sort();

  // Guard against a pattern that silently stops matching: an empty registry would make the widened
  // scan collapse back to the prototype-only one without a single test turning red.
  it('the delegate throw registry actually found the delegated throws', () => {
    expect(DELEGATE_THROWS.wwjs.size).toBeGreaterThanOrEqual(5);
    // Known-positive: getCatalog's throw lives in wwebjs-catalog.ts, not in the adapter prototype.
    expect(DELEGATE_THROWS.wwjs.has('getCatalog')).toBe(true);
    // Indexed rather than dotted so the unbound-method rule does not fire: this reads the body TEXT,
    // it never calls the method.
    const body = String((WhatsAppWebJsAdapter.prototype as unknown as Record<string, unknown>)['getCatalog']);
    expect(body).not.toMatch(UNSUPPORTED_RE);
  });

  it('matrix keys exactly match the interface methods (no missing, no stale)', () => {
    const missing = methods.filter(m => !(m in ENGINE_CAPABILITY_MATRIX));
    const stale = matrixKeys.filter(k => !methods.includes(k));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it.each(methods)('%s: throws ⇔ not-available', method => {
    const entry = ENGINE_CAPABILITY_MATRIX[method];
    for (const [adapter, ctor] of ADAPTERS) {
      const throws = liveThrows(ctor, method, adapter);
      const status = entry[adapter].status;
      // A `not-available` cell that does not throw is a phantom stub: the caller gets an empty
      // answer where the contract promises a 501.
      expect({ method, adapter, throws }).toEqual({ method, adapter, throws: status === 'not-available' });
    }
  });
});
