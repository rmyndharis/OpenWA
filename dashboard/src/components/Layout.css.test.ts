import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Layout.css under a right-to-left language. The sidebar is position: fixed with no inset, so in an
// RTL flex row it sits at the right edge, and every horizontal rule meant for the left edge has to be
// mirrored for it.

const DIR = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(DIR, 'Layout.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(join(DIR, 'Layout.tsx'), 'utf8');

interface Rule {
  media: string;
  selectors: string[];
  body: string;
}

// Style rules with the @media condition they sit under ('' at the top level).
function rules(text: string, media = ''): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const header = text.slice(i, open).trim();
    let depth = 1;
    let k = open + 1;
    while (k < text.length && depth) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}') depth--;
      k++;
    }
    const body = text.slice(open + 1, k - 1);
    if (header.startsWith('@media')) out.push(...rules(body, header));
    else if (!header.startsWith('@')) out.push({ media, selectors: header.split(',').map(s => s.trim()), body });
    i = k;
  }
  return out;
}

const all = rules(css);
const decl = (body: string, prop: string): string | undefined =>
  new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();
const find = (selector: string): Rule[] => all.filter(r => r.selectors.includes(selector));

// Layout.tsx switches to the phone layout on this media query.
const mobileQuery = /const MOBILE_QUERY = '([^']+)'/.exec(tsx)?.[1];

// A width test in script rounds: at 110% zoom innerWidth reads 767 for a 767.3px window, which (max-width: 767px)
// does not match, and the desktop sidebar was drawn inert. One query for both leaves no width where they disagree.
test('every media query in Layout.css is the one Layout.tsx switches to the phone layout on', () => {
  assert.ok(mobileQuery, 'Layout.tsx no longer names its phone query');
  assert.match(tsx, /matchMedia\(MOBILE_QUERY\)/);
  assert.doesNotMatch(tsx, /innerWidth/, 'Layout.tsx tests the window width in script again');
  const queries = [...css.matchAll(/@media\s*([^{]+?)\s*\{/g)].map(m => m[1]);
  assert.ok(queries.length > 0);
  for (const query of queries) assert.equal(query, mobileQuery);
});

test('the closed mobile sidebar slides off the right edge under RTL, and opens back in', () => {
  const closed = find("[dir='rtl'] .sidebar.mobile").filter(r => r.media);
  assert.equal(closed.length, 1, 'no RTL transform for the closed mobile sidebar');
  assert.equal(decl(closed[0].body, 'transform'), 'translateX(100%)');
  // Same specificity as the rule above, so the open state has to be scoped to RTL as well.
  const open = find("[dir='rtl'] .sidebar.mobile.open").filter(r => r.media === closed[0].media);
  assert.equal(open.length, 1, 'the RTL closed rule would also hide the open sidebar');
  assert.equal(decl(open[0].body, 'transform'), 'translateX(0)');
  // The shadow falls on the content side, which under RTL is the left.
  assert.match(decl(open[0].body, 'box-shadow') ?? '', /^-2px /);
});

// A shadow on the closed drawer reaches about 20px past its off-screen edge and showed as a grey band along the
// edge of every phone page.
test('the mobile sidebar casts its shadow only while it is open', () => {
  for (const dir of ['', "[dir='rtl'] "]) {
    const closed = find(`${dir}.sidebar.mobile`).filter(r => r.media);
    assert.equal(closed.length, 1, `${dir}.sidebar.mobile`);
    assert.equal(decl(closed[0].body, 'box-shadow'), undefined, `${dir}.sidebar.mobile shadows the screen edge`);
  }
  const open = find('.sidebar.mobile.open').filter(r => r.media);
  assert.equal(open.length, 1, 'no open rule for the mobile sidebar');
  assert.match(decl(open[0].body, 'box-shadow') ?? '', /^2px /);
});

// The language menu opens upward from the sidebar footer with all 15 languages in it, 559px tall. With no bound its
// first entries (English included) ended above the top edge of any window shorter than about 720px, and the sidebar
// is fixed, so nothing scrolled them back into view. The footer and the menu sit lower in the collapsed sidebar.
test('the language menu is bounded by the window and scrolls', () => {
  const menu = find('.language-menu-list').find(r => !r.media);
  assert.ok(menu, 'no base .language-menu-list rule');
  assert.equal(decl(menu.body, 'overflow-y'), 'auto');
  assert.equal(decl(menu.body, 'max-height'), 'calc(100vh - 13rem)');
  const collapsed = find('.sidebar.collapsed .language-menu-list').find(r => !r.media);
  assert.ok(collapsed, 'no collapsed .language-menu-list rule');
  assert.equal(decl(collapsed.body, 'max-height'), 'calc(100vh - 9rem)');
});

// 100vh is the large viewport on a phone whose browser collapses its toolbar, so a full-height scroller ended behind
// the toolbar and its last rows could not be scrolled into view. 100dvh follows the visible area; the 100vh line
// before it is the fallback for a browser without dvh.
const valuesOf = (body: string, prop: string): string[] =>
  [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))].map(m => m[1].trim());

test('the full-height sidebar and mobile scroller follow the dynamic viewport', () => {
  const sidebar = find('.sidebar').find(r => !r.media);
  assert.ok(sidebar, 'no base .sidebar rule');
  assert.deepEqual(valuesOf(sidebar.body, 'height'), ['100vh', '100dvh']);
  const scroller = find('.main-content.mobile').find(r => r.media);
  assert.ok(scroller, 'no mobile .main-content rule');
  assert.deepEqual(valuesOf(scroller.body, 'height'), ['100vh', '100dvh']);
  // .main-content keeps min-height: 100vh, which beats a smaller height: unless the scroller resets it, the dvh line
  // above never takes effect and the scroller stays as tall as the large viewport.
  assert.deepEqual(valuesOf(scroller.body, 'min-height'), ['0']);
});

// The header menu button turns into the close control while the drawer is open. A drawer that started at the top edge
// sat over it (sidebar 100, header 90) and the tap landed on the drawer's logo. The drawer starts under the header, and
// the header rises above the dimming overlay so the button stays visible and tappable.
test('the phone drawer starts below the mobile header and the header stays above the overlay', () => {
  const header = find('.mobile-header').find(r => r.media);
  assert.ok(header, 'no mobile .mobile-header rule');
  const headerHeight = decl(header.body, 'height');
  assert.match(headerHeight ?? '', /^\d+px$/);

  const drawer = find('.sidebar.mobile').find(r => r.media);
  assert.ok(drawer, 'no mobile .sidebar.mobile rule');
  assert.equal(decl(drawer.body, 'top'), headerHeight, 'the drawer starts above the bottom of the header');
  assert.deepEqual(valuesOf(drawer.body, 'height'), [
    `calc(100vh - ${headerHeight})`,
    `calc(100dvh - ${headerHeight})`,
  ]);
  // The page scroller keeps the same strip clear.
  const scroller = find('.main-content.mobile').find(r => r.media);
  assert.equal(decl(scroller?.body ?? '', 'padding-top'), headerHeight);

  // The language menu grows upward from the footer, and the drawer is a header shorter than the window: unbounded by
  // that strip it rose over the header and the menu button (Arabic, whose footer is the tallest).
  const menu = find('.sidebar.mobile .language-menu-list').find(r => r.media);
  assert.deepEqual(valuesOf(menu?.body ?? '', 'max-height'), [
    `calc(100vh - 13rem - ${headerHeight})`,
    `calc(100dvh - 13rem - ${headerHeight})`,
  ]);

  const overlay = find('.sidebar-overlay').find(r => r.media);
  assert.ok(
    Number(decl(header.body, 'z-index')) > Number(decl(overlay?.body ?? '', 'z-index')),
    'the overlay dims the button',
  );
});

test('the language menu is bounded by the dynamic viewport too, since it hangs off the sidebar bottom', () => {
  const menu = find('.language-menu-list').find(r => !r.media);
  assert.deepEqual(valuesOf(menu?.body ?? '', 'max-height'), ['calc(100vh - 13rem)', 'calc(100dvh - 13rem)']);
  const collapsed = find('.sidebar.collapsed .language-menu-list').find(r => !r.media);
  assert.deepEqual(valuesOf(collapsed?.body ?? '', 'max-height'), ['calc(100vh - 9rem)', 'calc(100dvh - 9rem)']);
});

// The Plugins page pins its status rail with position: sticky. overflow-x: hidden makes .main-content a scroll
// container (overflow-y computes to auto), the nearest one a sticky box sticks to, and that one never scrolls, so
// the rail scrolled away with the page. clip hides the overflow without that.
test('the main content clips sideways overflow without becoming a scroll container', () => {
  const main = find('.main-content').find(r => !r.media);
  assert.ok(main, 'no base .main-content rule');
  assert.equal(decl(main.body, 'overflow-x'), 'clip');
});

test('the collapse icon is mirrored once, by the icon Layout.tsx picks', () => {
  assert.match(tsx, /isRtl \?\s*\(?\s*<PanelRightClose/, 'Layout.tsx no longer swaps the collapse icon for RTL');
  assert.match(tsx, /isRtl \?\s*\(?\s*<PanelRightOpen/, 'Layout.tsx no longer swaps the expand icon for RTL');
  for (const r of all.filter(r => r.selectors.some(s => s.includes('.collapse-toggle') && s.includes('svg')))) {
    assert.equal(decl(r.body, 'transform'), undefined, `${r.selectors.join(', ')} flips the icon again`);
  }
});

// The collapse toggle sits in the header row, pushed to its end by a logical margin, not on the sidebar edge, so it
// follows the page direction by itself. A physical offset or an absolute position would need an RTL mirror again, and
// a heavier rule that set `right` once won over that mirror and pushed the RTL toggle half off the screen.
test('the collapse toggle sits in the header row with logical offsets, so a right-to-left page needs no mirror', () => {
  const toggles = all.filter(r => r.selectors.some(s => /\.collapse-toggle$/.test(s)));
  const base = toggles.find(r => !r.media && r.selectors.includes('.collapse-toggle'));
  assert.ok(base, 'no base .collapse-toggle rule');
  assert.equal(decl(base.body, 'margin-inline-start'), 'auto');
  for (const r of toggles) {
    for (const prop of ['position', 'left', 'right', 'margin-left', 'margin-right']) {
      assert.equal(decl(r.body, prop), undefined, `${r.selectors.join(', ')} sets ${prop}`);
    }
  }
  assert.equal(find("[dir='rtl'] .collapse-toggle").length, 0, 'an RTL rule moves the toggle again');
});

// -webkit-overflow-scrolling: touch gave iOS momentum scrolling before iOS 13, which now scrolls every overflow area that
// way. WebKit still honours the property on iPhone and gives the element a stacking context (StyleAdjuster.cpp:
// "Touch overflow scrolling creates a stacking context"), which would trap the page-level modal overlays (z-index
// 1000) inside the scroller, under the fixed mobile header (90) and sidebar (100).
test('no stylesheet asks for the legacy touch overflow scrolling', () => {
  const sheets = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sheets(full);
      return entry.name.endsWith('.css') ? [full] : [];
    });
  const files = sheets(join(DIR, '..'));
  assert.ok(files.length >= 20, `only ${files.length} stylesheets found`);
  const offenders = files.filter(file =>
    /-webkit-overflow-scrolling/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')),
  );
  assert.deepEqual(
    offenders.map(file => file.slice(DIR.length - 'components'.length)),
    [],
  );
});

test('a long update notice ends in an ellipsis, and its focus ring is not clipped by the brand', () => {
  const [badge] = find('.brand-update');
  assert.equal(decl(badge.body, 'text-overflow'), 'ellipsis');
  assert.equal(decl(badge.body, 'overflow'), 'hidden');
  assert.equal(decl(badge.body, 'max-width'), '100%');
  // The brand clips what leaves it; its padding has to hold the global ring, outline plus offset, all round.
  const [brand] = find('.sidebar-brand');
  assert.equal(decl(brand.body, 'overflow'), 'hidden');
  const index = readFileSync(join(DIR, '..', 'index.css'), 'utf8');
  const ring = /a:focus-visible[^{]*\{[^}]*outline:\s*(\d+)px[^}]*outline-offset:\s*(\d+)px/.exec(index);
  assert.ok(ring, 'index.css no longer draws the link focus ring');
  const reach = Number(ring[1]) + Number(ring[2]);
  assert.equal(decl(brand.body, 'padding'), `${reach}px`);
  assert.equal(decl(brand.body, 'margin'), `-${reach}px`);
});
