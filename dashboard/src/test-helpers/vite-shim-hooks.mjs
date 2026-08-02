// ESM customization hooks letting the bare `node --experimental-strip-types --test` runner load
// the dashboard's Vite-style sources:
//   - .tsx            → transpiled with the project's own TypeScript (jsx: react-jsx)
//   - extensionless relative imports → resolved by trying .tsx/.ts/.js/.mjs/.json (and /index.*)
//   - .json           → wrapped as `export default` (Node would demand import attributes)
//   - .css            → stubbed as an empty module
//   - .svg/.png/.jpg/.webp → stubbed as `export default '<url>'` (Vite resolves an asset import to
//     its URL string; Node has no loader for these extensions at all)
//   - .ts files reading import.meta.env → transpiled with a shim (import.meta.env is a Vite
//     global Node does not provide); every other .ts falls through to --experimental-strip-types
//
// Registered via test-helpers/register-hooks.ts. node:test runs each test file in its own child
// process, so these hooks only ever affect the component smoke-test process — the pure-logic
// tests never register them.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.js', '.mjs', '.json'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // Only patch up relative specifiers (Vite resolves these extensionless; Node does not).
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw error;
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = base + ext;
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = path.join(base, `index${ext}`);
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  if (url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.webp')) {
    // Vite resolves an asset import to its URL string. The tests never read the bytes; they only
    // need the import to succeed and the value to be a string an <img src> can take.
    return { format: 'module', source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
  }
  if (url.endsWith('.json')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${source};`, shortCircuit: true };
  }
  if (url.endsWith('.tsx')) {
    return { format: 'module', source: await transpile(url), shortCircuit: true };
  }
  if (url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    if (!source.includes('import.meta.env')) return nextLoad(url, context);
    return { format: 'module', source: await transpile(url, source), shortCircuit: true };
  }
  return nextLoad(url, context);
}

async function transpile(url, presetSource) {
  const fileName = fileURLToPath(url);
  const source = presetSource ?? (await readFile(fileName, 'utf8'));
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName,
  });
  // import.meta is extensible; seeding `env` keeps Vite-style `import.meta.env.X` reads working.
  const shim = source.includes('import.meta.env') ? 'import.meta.env ??= {};\n' : '';
  return shim + outputText;
}
