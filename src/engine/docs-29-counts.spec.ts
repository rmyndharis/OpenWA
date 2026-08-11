import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `docs/29` states the same three figures in ten places — the intro, the architecture prose, a
 * mermaid node, two section headings, the §29.4 totals and the §29.8 summary. All ten are
 * hand-written restatements of what `engine-capability-matrix.ts` contains.
 *
 * Adding one interface method updated the matrix and §29.8 and left the other six behind, and
 * nothing noticed: the parity gates compare the matrix to the interface, and no check reads the
 * prose. This binds every count-shaped claim in the file to the source it restates.
 */
describe('docs/29 counts match the capability matrix', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8');

  /** Recount from the matrix source. Line-oriented on purpose — see the note on the fixture below. */
  const recount = () => {
    const lines = read('src', 'engine', 'engine-capability-matrix.ts').split('\n');
    const rows: { wwjs: string | null; baileys: string | null }[] = [];
    let current: { wwjs: string | null; baileys: string | null } | null = null;
    for (const line of lines) {
      if (/^ {2}[A-Za-z][A-Za-z0-9_]*: \{/.test(line)) {
        current = { wwjs: null, baileys: null };
        rows.push(current);
      }
      if (!current) continue;
      const wwjs = line.match(/wwjs: \{ ?status: '([a-z-]+)'/);
      if (wwjs && current.wwjs === null) current.wwjs = wwjs[1];
      const baileys = line.match(/baileys: \{ ?status: '([a-z-]+)'/);
      if (baileys && current.baileys === null) current.baileys = baileys[1];
    }
    const complete = rows.filter(r => r.wwjs && r.baileys);
    // A parse that dropped rows would understate every figure and make the whole file "agree".
    expect(complete.length).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(80);

    const ok = (s: string | null): boolean => s === 'supported';
    const supported = rows.filter(r => ok(r.wwjs)).length + rows.filter(r => ok(r.baileys)).length;
    // The REST caller's view counts the two store-backed status reads as neutral rather than
    // wwjs-only; docs/29 states that adjustment explicitly where it uses the figure.
    const neutralRaw = rows.filter(r => ok(r.wwjs) && ok(r.baileys)).length;
    return { methods: rows.length, cells: rows.length * 2, supported, neutral: neutralRaw + 2 };
  };

  /** Every phrasing in the file that restates one of those figures. */
  const CLAIMS: { label: string; re: RegExp; of: 'methods' | 'cells' | 'supported' | 'neutral' }[] = [
    { label: 'intro coverage', re: /Coverage is total: all (\d+) `IWhatsAppEngine` methods/, of: 'methods' },
    { label: 'section guide', re: /Rows are the (\d+) `IWhatsAppEngine` methods/, of: 'methods' },
    { label: 'architecture prose', re: /`IWhatsAppEngine` interface \((\d+) methods/, of: 'methods' },
    { label: 'mermaid node', re: /IWhatsAppEngine - (\d+) methods/, of: 'methods' },
    { label: '29.4 heading', re: /contract view \((\d+) methods\)/, of: 'methods' },
    { label: '29.4 totals methods', re: /\*\*Totals:\*\* (\d+) methods/, of: 'methods' },
    { label: '29.4 totals cells', re: /\*\*Totals:\*\* \d+ methods → (\d+) adapter cells/, of: 'cells' },
    { label: '29.4 totals supported', re: /adapter cells: \*\*(\d+) ✅/, of: 'supported' },
    { label: '29.4 REST view', re: /From the REST caller's side: \*\*(\d+)\*\* methods/, of: 'neutral' },
    { label: '29.8 methods', re: /- \*\*(\d+)\*\* interface methods/, of: 'methods' },
    { label: '29.8 cells', re: /interface methods → \*\*(\d+)\*\* adapter cells/, of: 'cells' },
    { label: '29.8 supported', re: /adapter cells: \*\*(\d+) ✅\*\*/, of: 'supported' },
    { label: '29.8 restated supported', re: /Of the (\d+) ✅ cells/, of: 'supported' },
    { label: '29.8 REST view', re: /REST caller's view: \*\*(\d+)\*\* engine-neutral/, of: 'neutral' },
  ];

  /**
   * The patch counts are a SEPARATE source — `scripts/` — and were outside the claim list above, so
   * they drifted exactly the way the interface figures used to: this release added a patcher to each
   * library and the mermaid node kept saying 4 and 1. Derived from disk the same way
   * `scripts/dockerfile-patchers.spec.js` derives its list, so adding a patcher updates the expected
   * value rather than requiring someone to remember the prose.
   */
  const patchCounts = () => {
    const files = readdirSync(join(__dirname, '..', '..', 'scripts')).filter(
      f => f.startsWith('patch-') && f.endsWith('.js') && !f.endsWith('.spec.js'),
    );
    return {
      total: files.length,
      wwjs: files.filter(f => f.startsWith('patch-wwebjs-')).length,
      baileys: files.filter(f => f.startsWith('patch-baileys-')).length,
    };
  };

  it('states the install-time patch counts the scripts directory actually contains', () => {
    const expected = patchCounts();
    const doc = read('docs', '29-engine-capability-matrix.md');

    // Guard the derivation: a renamed prefix would make every expectation below zero and pass.
    expect(expected.total).toBeGreaterThan(4);
    expect(expected.wwjs + expected.baileys).toBe(expected.total);

    // 29.3's opening sentence and 29.3.2's split spell the figure in prose rather than digits, which
    // is why they drifted while the digit-shaped claims held: a patcher was added to each library and
    // the words stayed at "five" and "1 on Baileys".
    const WORDS: Record<string, number> = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const spelled = doc.match(/OpenWA ships (\w+) exact, self-disabling source transforms/);
    const wrongProse: string[] = [];
    if (!spelled) wrongProse.push('29.3 opening: phrasing no longer found in the document');
    else if (WORDS[spelled[1]] !== expected.total) {
      wrongProse.push(`29.3 opening: says ${spelled[1]}, scripts/ has ${expected.total}`);
    }

    const claims: { label: string; re: RegExp; want: number }[] = [
      { label: 'intro total', re: /(\d+) install-time patches \(29\.3\)/, want: expected.total },
      { label: '29.3.2 split wwjs', re: /engine-specific \((\d+) on wwjs/, want: expected.wwjs },
      {
        label: '29.3.2 split baileys',
        re: /engine-specific \(\d+ on wwjs,\s*(\d+) on Baileys\)/,
        want: expected.baileys,
      },
      { label: 'mermaid wwjs node', re: /whatsapp-web\.js [\d.]+<br\/>\+ (\d+) OpenWA patch/, want: expected.wwjs },
      { label: 'mermaid baileys node', re: /baileys [\w.-]+<br\/>\+ (\d+) OpenWA patch/, want: expected.baileys },
      { label: '29.8 total', re: /- \*\*(\d+)\*\* install-time patches/, want: expected.total },
      { label: '29.8 split', re: /install-time patches \((\d+) whatsapp-web\.js/, want: expected.wwjs },
      {
        label: '29.8 split baileys',
        re: /install-time patches \(\d+ whatsapp-web\.js \+ (\d+) Baileys\)/,
        want: expected.baileys,
      },
    ];

    const wrong: string[] = [];
    for (const claim of claims) {
      const found = doc.match(claim.re);
      // A phrasing that stopped matching is drift too — the claim did not disappear, the check did.
      if (!found) {
        wrong.push(`${claim.label}: phrasing no longer found in the document`);
        continue;
      }
      const actual = Number(found[1]);
      if (actual !== claim.want) wrong.push(`${claim.label}: says ${actual}, scripts/ has ${claim.want}`);
    }

    expect([...wrongProse, ...wrong]).toEqual([]);
  });

  /**
   * The figures below restate something the DOCUMENT itself contains rather than the matrix, so a
   * matrix-derived check cannot see them drift — and they did: demoting one cell moved the
   * not-available span, marking three rows moved the patch-dependency count, and the 29.5.2 prose
   * split kept the pre-demotion numbers. Each is recounted from the table it summarises.
   */
  it('summarises its own tables with the numbers those tables contain', () => {
    const doc = read('docs', '29-engine-capability-matrix.md');
    const wrong: string[] = [];

    const section = (from: RegExp, to: RegExp): string => {
      const start = doc.search(from);
      const end = doc.slice(start + 1).search(to);
      return end < 0 ? doc.slice(start) : doc.slice(start, start + 1 + end);
    };

    // 29.8's not-available span must match 29.4's, which the matrix-derived test already pins.
    const spanning = doc.match(/0 uncertain\), spanning \*\*(\d+)\*\* methods/);
    const across = doc.match(/0 uncertain\) across (\d+) methods/);
    if (!spanning || !across) wrong.push('not-available span: one of the two phrasings no longer matches');
    else if (spanning[1] !== across[1])
      wrong.push(`not-available span: 29.8 says ${spanning[1]}, 29.4 says ${across[1]}`);

    // 29.8's wwjs patch-dependency count must match the ✅🔧ⁿ marks 29.4 actually carries. 🔧⁶ is the
    // one baileys row-level mark, so it is excluded from the wwjs figure.
    const contract = section(/^## 29\.4 /m, /^## 29\.5 /m);
    const marks = [...contract.matchAll(/✅🔧([¹²³⁴⁵⁶⁷])/g)].map(m => m[1]);
    const wwjsMarks = marks.filter(m => m !== '⁶').length;
    const claimed = doc.match(/\*\*(\d+) wwjs cells carry an explicit patch dependency\*\*/);
    if (!claimed) wrong.push('patch dependency count: phrasing no longer found');
    else if (Number(claimed[1]) !== wwjsMarks) {
      wrong.push(`patch dependency count: says ${claimed[1]}, 29.4 carries ${wwjsMarks}`);
    }

    // 29.8's wwjs inventory split must match the 29.5.2 table it summarises.
    const inventory = section(/^### 29\.5\.2 /m, /^### 29\.5\.3 /m);
    const wired = (inventory.match(/^\| `[^|]+\| *✅/gm) ?? []).length;
    const unexposed = (inventory.match(/^\| `[^|]+\| *❌/gm) ?? []).length;
    const split = doc.match(
      /wwjs \*\*\d+\*\* Client methods — (\d+) wired,[\s\S]{0,60}?\*\*(\d+) ❌ not\s+exposed\*\*/,
    );
    if (!split) wrong.push('29.5.2 split: phrasing no longer found');
    else {
      if (Number(split[1]) !== wired) wrong.push(`29.5.2 wired: says ${split[1]}, the table has ${wired}`);
      if (Number(split[2]) !== unexposed)
        wrong.push(`29.5.2 not-exposed: says ${split[2]}, the table has ${unexposed}`);
    }

    // Guard every selector: a reworded table would make all four comparisons vacuous.
    expect({ marks: marks.length > 0, wired: wired > 0, unexposed: unexposed > 0 }).toEqual({
      marks: true,
      wired: true,
      unexposed: true,
    });
    expect(wrong).toEqual([]);
  });

  it('states the same figures everywhere it states them', () => {
    const expected = recount();
    const doc = read('docs', '29-engine-capability-matrix.md');

    const wrong: string[] = [];
    for (const claim of CLAIMS) {
      const found = doc.match(claim.re);
      // A phrasing that stopped matching is drift too — the claim did not disappear, the check did.
      if (!found) {
        wrong.push(`${claim.label}: phrasing no longer found in the document`);
        continue;
      }
      const actual = Number(found[1]);
      if (actual !== expected[claim.of]) {
        wrong.push(`${claim.label}: says ${actual}, matrix has ${expected[claim.of]}`);
      }
    }

    expect(wrong).toEqual([]);
  });
});
