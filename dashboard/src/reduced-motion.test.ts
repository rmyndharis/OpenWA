import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A user who turned on "reduce motion" still got modals sliding up, toasts sliding in and the sidebar animating its
// width. index.css switches animations and transitions off in one block; the loading spinners are the one motion kept,
// because without it a wait shows no sign of progress.

const SRC = dirname(fileURLToPath(import.meta.url));
const SPINNERS = ['.animate-spin', '.spin-slow'];

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extension);
    return entry.name.endsWith(extension) && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const stripped = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('index.css flattens animations and transitions under prefers-reduced-motion, except the spinners', () => {
  const css = stripped(join(SRC, 'index.css'));
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.notEqual(at, -1, 'index.css has no prefers-reduced-motion block');
  const open = css.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  const block = css.slice(open + 1, i - 1);
  const rule = /([^{}]+)\{([^{}]*)\}/.exec(block);
  assert.ok(rule, 'the block holds no rule');
  for (const property of [
    'animation-duration',
    'animation-iteration-count',
    'transition-duration',
    'scroll-behavior',
  ]) {
    assert.match(rule[2], new RegExp(`${property}:[^;]*!important`), `${property} is not forced`);
  }
  for (const spinner of SPINNERS)
    assert.ok(rule[1].includes(`:not(${SPINNERS.join(', ')})`), `${spinner} is not exempt`);
});

test('only the spinners loop, so nothing else keeps moving once the block is on', () => {
  const looping = filesUnder(SRC, '.css').flatMap(file =>
    [...stripped(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(m => /animation:[^;]*\binfinite\b/.test(m[2]))
      .map(m => m[1].trim().replace(/\s+/g, ' ')),
  );
  assert.ok(looping.length >= 3, `found only ${looping.length} looping animations`);
  assert.deepEqual(
    looping.filter(selector => !SPINNERS.some(spinner => selector.endsWith(spinner))),
    [],
  );
});

test('a script-driven smooth scroll asks whether the user reduced motion', () => {
  const offenders = filesUnder(SRC, '.tsx')
    .filter(file => {
      const source = readFileSync(file, 'utf8');
      return /behavior:[^\n]*['"]smooth['"]/.test(source) && !source.includes('prefers-reduced-motion');
    })
    .map(file => file.slice(SRC.length + 1));
  assert.deepEqual(offenders, []);
});
