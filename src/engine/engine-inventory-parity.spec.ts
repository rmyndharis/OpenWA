import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_CAPABILITY_MATRIX } from './engine-capability-matrix';

/**
 * Drift invariants for the hand-maintained halves of docs/29-engine-capability-matrix.md.
 *
 * 29.4 is already guarded (engine-parity.spec.ts) and the symbol LISTS in 29.5 are already guarded
 * (check-upstream-surface.mjs vs the snapshot). What nothing watched was the two columns a human
 * fills in by hand:
 *
 *   - 29.5.1/29.5.2 "OpenWA exposure" — which library symbol the adapters actually use.
 *   - 29.5.4 "OpenWA" — which library events the adapters actually subscribe to.
 *
 * Both drifted: symbols marked ✅/⚙️ that appear only inside a comment, and events marked ✅ with no
 * listener at all. Those are exactly the marks a reader triaging backlog work trusts most, so they
 * get a gate.
 *
 * The name-collision half of that is now closed: a second invariant requires the symbol to be
 * reached THROUGH a library handle, so an adapter method of the same name no longer satisfies it.
 * It found two rows that a name search had blessed for as long as they existed — Baileys `star`
 * (`starMessage` goes through `chatModify`) and wwjs `sendSeen` (the `Chat` model method, not the
 * `Client` one).
 *
 * What this gate still CANNOT see, and why (do not read a green run as more than it is):
 *   - Under-mapping. A ✅ row listing four interface methods when the symbol really serves eight
 *     still passes; the check is "the claim has code behind it", not "the claim is exhaustive".
 *   - Direction. Mapping symbol A to interface method B instead of C passes as long as both exist,
 *     because nothing here resolves a call site back to the interface method enclosing it.
 */
const DOC = join(__dirname, '..', '..', 'docs', '29-engine-capability-matrix.md');
const ADAPTER_DIR = join(__dirname, 'adapters');

type Row = { symbol: string; exposure: string };
type EventRow = { event: string; consumed: boolean };
type Engine = 'baileys' | 'wwjs';
type Snapshot = {
  baileys: { socketMethods: string[]; events: string[] };
  'whatsapp-web.js': { clientMethods: string[]; events: string[] };
};

function docText(): string {
  return readFileSync(DOC, 'utf8');
}

/** Adapter sources, comments removed but string literals kept — for finding `.on('event')`. */
function adapterSourcesWithStrings(): string {
  return readdirSync(ADAPTER_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map(f => stripComments(readFileSync(join(ADAPTER_DIR, f), 'utf8')))
    .join('\n');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:/])\/\/[^\n]*/g, '$1 ');
}

/**
 * A symbol counts as used only as a property access (`.symbol`), never as a bare word. That is what
 * separates a real call from the same name sitting inside a string — `EngineNotSupportedError('x')`
 * names its own method, and a doc-mirroring error message must not be able to satisfy this gate.
 *
 * String literals are deliberately NOT stripped: doing so needs a real tokenizer, and a regex that
 * tries collapses on an apostrophe inside a double-quoted string ("don't"), silently eating the code
 * between it and the next quote — which fails OPEN, the one direction a drift gate must never fail.
 */
function isUsedInAdapterCode(symbol: string, code: string): boolean {
  return new RegExp(`\\.${symbol}\\b`).test(code);
}

/** Rows of the 29.5.1 / 29.5.2 inventory tables, by engine. */
function readInventory(engine: Engine): Row[] {
  const doc = docText();
  const start = doc.indexOf(engine === 'baileys' ? '### 29.5.1' : '### 29.5.2');
  const end = doc.indexOf(engine === 'baileys' ? '### 29.5.2' : '### 29.5.3');
  const rows: Row[] = [];
  for (const line of doc.slice(start, end).split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|(.+?)\|\s*$/);
    if (m) rows.push({ symbol: m[1], exposure: m[2].trim() });
  }
  return rows;
}

/** Rows of the 29.5.4 event tables, by engine. The tables carry two event pairs per line. */
function readEvents(engine: Engine): EventRow[] {
  const doc = docText();
  const section = doc.slice(doc.indexOf('### 29.5.4'), doc.indexOf('## 29.6'));
  const bailStart = section.indexOf('**Baileys');
  const wwjsStart = section.indexOf('**whatsapp-web.js');
  const block = engine === 'baileys' ? section.slice(bailStart, wwjsStart) : section.slice(wwjsStart);
  const rows: EventRow[] = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-+/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());
    for (let i = 0; i < cells.length - 1; i++) {
      const m = cells[i].match(/^`([a-zA-Z][a-zA-Z_.-]*)`$/);
      if (m) {
        rows.push({ event: m[1], consumed: cells[i + 1].startsWith('✅') });
        i++;
      }
    }
  }
  return rows;
}

const registeredEvents = new Set(
  [...adapterSourcesWithStrings().matchAll(/\.on\(\s*'([a-zA-Z][a-zA-Z_.-]*)'/g)].map(m => m[1]),
);

describe('engine inventory (docs/29 §29.5) — drift invariants', () => {
  // Guards against a parser that silently stops matching: an empty or short parse would make every
  // invariant below vacuously true. The expected sizes are the gated snapshot's, not magic numbers.
  it('the document parsers actually found the tables', () => {
    const snapshot = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'scripts', 'upstream-surface.snapshot.json'), 'utf8'),
    ) as Snapshot;
    expect({
      baileysRows: readInventory('baileys').length,
      wwjsRows: readInventory('wwjs').length,
      baileysEvents: readEvents('baileys').length,
      wwjsEvents: readEvents('wwjs').length,
    }).toEqual({
      baileysRows: snapshot.baileys.socketMethods.length,
      wwjsRows: snapshot['whatsapp-web.js'].clientMethods.length,
      baileysEvents: snapshot.baileys.events.length,
      wwjsEvents: snapshot['whatsapp-web.js'].events.length,
    });
  });

  // The source scrubber is the other thing that can fail open: if it stopped removing comments,
  // every "symbol appears in code" assertion would pass on a mention inside a comment — the exact
  // defect this gate exists to catch. Checked on a synthetic sample so it never depends on the repo.
  it('the comment scrubber and the usage test behave on a synthetic sample', () => {
    const sample = [
      '// a comment mentioning .commentGhost()',
      '/* a block mentioning .blockGhost() */',
      'const msg = "the adapter doesn\'t call ghostInString";',
      "throw new EngineNotSupportedError('namedGhost');",
      'this.sock().realCall();',
      "sock.ev.on('real.event', handler);",
    ].join('\n');
    const scrubbed = stripComments(sample);
    // A mention inside a comment must not count as usage — the defect this gate exists to catch.
    expect(isUsedInAdapterCode('commentGhost', scrubbed)).toBe(false);
    expect(isUsedInAdapterCode('blockGhost', scrubbed)).toBe(false);
    // Nor may a method naming itself in its own throw.
    expect(isUsedInAdapterCode('namedGhost', scrubbed)).toBe(false);
    // A real property access must count, and the apostrophe above must not have eaten it.
    expect(isUsedInAdapterCode('realCall', scrubbed)).toBe(true);
    expect(scrubbed).toMatch(/real\.event/);
    // The real adapter corpus must be non-trivial, or the scan proves nothing.
    expect(adapterSourcesWithStrings().length).toBeGreaterThan(50_000);
    expect(registeredEvents.size).toBeGreaterThanOrEqual(20);
  });

  describe.each<Engine>(['baileys', 'wwjs'])('%s', engine => {
    it('every ✅/⚙️ exposure mark has the symbol somewhere in adapter CODE, not just a comment', () => {
      const code = adapterSourcesWithStrings();
      const unsupported = readInventory(engine)
        .filter(r => r.exposure.startsWith('✅') || r.exposure.startsWith('⚙️'))
        .filter(r => !isUsedInAdapterCode(r.symbol, code))
        .map(r => r.symbol);
      expect(unsupported).toEqual([]);
    });

    /**
     * The check above asks whether the NAME occurs in adapter code, which our own identically-named
     * methods satisfy: `getChatLabels` was marked used while `Client.getChatLabels` was never
     * called, because the adapter defines a method of that name. Two rows were wrong for exactly
     * that reason — Baileys `star` (starMessage goes through `chatModify({ star })`) and wwjs
     * `sendSeen` (the adapter calls the `Chat` model method, not the `Client` one).
     *
     * So this asks the stronger question: is the symbol reached THROUGH a library handle? The
     * handle shapes are taken from what the adapters actually do — `this.sock()`/`this.client()`,
     * `getSocket()`, and any socket/client-shaped local (`sock`, `sourceSock`, `client`) — and a
     * member may be a reference rather than a call, since `updateMediaMessage` is passed as one.
     * Casts are tolerated: `(this.client() as unknown as BusinessClient).getLabels()` is a real
     * call, and so is computed dispatch, `this.client()[op](…)` with the name supplied as a literal.
     */
    it('every ✅/⚙️ exposure mark is reached through a library handle, not just named', () => {
      const code = adapterSourcesWithStrings().replace(/\s+/g, ' ');
      const handle =
        engine === 'wwjs'
          ? String.raw`(?:\bthis\.client\(\)|\b\w*[Cc]lient\b)`
          : String.raw`(?:\bthis\.sock\(\)|\bgetSocket\(\)|\b\w*[Ss]ock\b)`;
      const reached = (symbol: string): boolean => {
        const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`${handle}[^;{}]{0,90}?\\.\\s*${s}\\s*[(<.,)\\]]`).test(code)) return true;
        // computed dispatch through the handle, with the method name supplied as a literal
        return new RegExp(`${handle}\\s*\\[`).test(code) && new RegExp(`['"\`]${s}['"\`]`).test(code);
      };

      const marked = readInventory(engine).filter(r => r.exposure.startsWith('✅') || r.exposure.startsWith('⚙️'));
      // Guard the selector: an empty or tiny set would make the assertion vacuous.
      expect(marked.length).toBeGreaterThan(30);
      expect(marked.filter(r => !reached(r.symbol)).map(r => r.symbol)).toEqual([]);
    });

    it('every interface method named in a ✅ exposure cell is `supported` for this engine', () => {
      const offenders: string[] = [];
      for (const row of readInventory(engine)) {
        if (!row.exposure.startsWith('✅')) continue;
        for (const [, method] of row.exposure.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/g)) {
          const entry = ENGINE_CAPABILITY_MATRIX[method];
          if (!entry) continue; // prose backtick, not an interface method
          if (entry[engine].status !== 'supported') offenders.push(`${row.symbol} → ${method}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('the ✅ event marks match the listeners the adapters register', () => {
      const wrong = readEvents(engine)
        .filter(row => row.consumed !== registeredEvents.has(row.event))
        .map(row => `${row.event}: doc=${row.consumed ? '✅' : '❌'} registered=${registeredEvents.has(row.event)}`);
      expect(wrong).toEqual([]);
    });
  });
});
