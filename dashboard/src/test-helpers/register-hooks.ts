/// <reference types="node" />
// Registers the ESM customization hooks that let the bare node:test runner load the dashboard's
// Vite-style sources (TSX, extensionless imports, CSS, JSON — see vite-shim-hooks.mjs). A test
// file must import this module for its side effect BEFORE any dynamic import of app modules:
// Node resolves+loads the entry file's static imports before user code runs, so app modules can
// only be pulled in dynamically after registration.
import { register } from 'node:module';

register('./vite-shim-hooks.mjs', import.meta.url);
