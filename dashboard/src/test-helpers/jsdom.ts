// JSDOM bootstrap for component smoke tests under the bare `node --test` runner (no vitest/jest).
// Installs a JSDOM window/document (+ the globals React DOM and Testing Library need) onto
// globalThis. Call once, from a test file's `before()`, BEFORE dynamically importing any app
// module — some modules read `window.location.origin` at import time (useWebSocket).

/**
 * Installs JSDOM globals on globalThis. Idempotent: later calls replace the window with a fresh
 * one, which is what a second test file in the same process would want anyway.
 */
export async function installJsdomGlobals(url = 'http://localhost/'): Promise<void> {
  // jsdom ships no bundled types and @types/jsdom is not installed; import it untyped and narrow
  // to the one member this helper uses.
  // @ts-expect-error -- Could not find a declaration file for module 'jsdom'
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
    // Gives the window requestAnimationFrame/cancelAnimationFrame (the scroll-position hook uses
    // them) and makes timers in jsdom behave like a visible tab.
    pretendToBeVisual: true,
  }) as { window: Window & typeof globalThis };
  const { window } = dom;

  const g = globalThis as Record<string, unknown>;
  const define = (key: string, value: unknown): void => {
    // Some globals are getter-only on Node's globalThis (navigator) — plain assignment throws.
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define('window', window);
  define('document', window.document);
  define('navigator', window.navigator);
  // IDL accessors on the jsdom window brand-check `this`, so they can't be copied as descriptors
  // (calling them with this === globalThis throws "Illegal invocation"). Install them as values:
  // the storage/location objects themselves work with any receiver.
  define('localStorage', window.localStorage);
  define('sessionStorage', window.sessionStorage);
  define('location', window.location);
  define('getComputedStyle', window.getComputedStyle.bind(window));
  define('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  define('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  // Constructors and plain functions (HTMLElement, Node, Event, CustomEvent, MutationObserver,
  // FileReader, ...) — needed by React DOM's instanceof checks and Testing Library's queries.
  // Node's own globals (fetch, Response, crypto, Blob, ...) win by being skipped, not replaced.
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue;
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (descriptor && 'value' in descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
  // React 19 only runs act() when this flag is set; Testing Library drives act through it.
  g.IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}
