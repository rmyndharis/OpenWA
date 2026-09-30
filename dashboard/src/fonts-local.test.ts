import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The dashboard bundles its fonts and the gateway CSP allows fonts and styles only from 'self', so a
// remote stylesheet or a family name the bundled packages do not register falls back to a system font.

const SRC = dirname(fileURLToPath(import.meta.url));
const cssFiles = (readdirSync(SRC, { recursive: true }) as string[]).filter(f => f.endsWith('.css'));

test('no stylesheet loads a remote font or stylesheet', () => {
  for (const file of cssFiles) {
    const css = readFileSync(join(SRC, file), 'utf8');
    assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|@import\s+url\(\s*['"]?https?:/, file);
  }
});

test('every bundled family is named by the name its package registers', () => {
  for (const family of ['Plus Jakarta Sans', 'JetBrains Mono', 'Heebo', 'Noto Sans Arabic']) {
    for (const file of cssFiles) {
      const css = readFileSync(join(SRC, file), 'utf8');
      const plain = css.split(`'${family}'`).length - 1;
      const variable = css.split(`'${family} Variable'`).length - 1;
      assert.equal(plain, variable, `${file}: '${family}' without '${family} Variable' before it`);
    }
  }
});

test('the entry point imports every bundled font', () => {
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
  for (const spec of [
    '@fontsource-variable/plus-jakarta-sans',
    '@fontsource-variable/plus-jakarta-sans/wght-italic.css',
    '@fontsource-variable/jetbrains-mono',
    '@fontsource-variable/heebo',
    '@fontsource-variable/noto-sans-arabic',
  ]) {
    assert.ok(main.includes(`import '${spec}';`), `main.tsx does not import ${spec}`);
  }
});

test('the build never inlines a font as a data: URI', async () => {
  const { default: config } = (await import('../vite.config.ts')) as {
    default: { build?: { assetsInlineLimit?: unknown } };
  };
  const limit = config.build?.assetsInlineLimit;
  assert.equal(typeof limit, 'function');
  const inline = limit as (file: string, content: Buffer) => boolean | undefined;
  assert.equal(inline('/x/plus-jakarta-sans-cyrillic-ext-wght-normal.woff2', Buffer.alloc(1_700)), false);
  assert.equal(inline('/x/icon.svg', Buffer.alloc(100)), undefined);
});
