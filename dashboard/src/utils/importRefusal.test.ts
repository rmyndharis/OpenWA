import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldOfferStopOrphansRetry } from './importRefusal.ts';

// The retry this predicate gates is DESTRUCTIVE: it re-POSTs the replace-all with stopOrphans=true,
// which tears down live engines. Branching on the 409 status alone offered that retry from a dialog
// whose message says "another import is already running; wait for it" — so OK read as an
// acknowledgement and ran a second full replace nobody asked for.

test('offers the retry for the orphan-engine refusal, which is a real decision', () => {
  assert.equal(shouldOfferStopOrphansRetry(409, 'IMPORT_WOULD_ORPHAN_ENGINES', false), true);
});

test('never offers the retry when another import is already running', () => {
  assert.equal(shouldOfferStopOrphansRetry(409, 'IMPORT_ALREADY_RUNNING', false), false);
});

test('does not loop: a 409 on the retry itself is not offered again', () => {
  assert.equal(shouldOfferStopOrphansRetry(409, 'IMPORT_WOULD_ORPHAN_ENGINES', true), false);
});

test('a 409 carrying no code at all does not open the destructive confirm', () => {
  // Not hypothetical: a reverse proxy, a gateway error page or a body that never parsed all arrive
  // with no code, and the api client then synthesises the message as "HTTP 409". Identifying the
  // destructive case by the ABSENCE of a code would offer to tear down live engines for those.
  assert.equal(shouldOfferStopOrphansRetry(409, undefined, false), false);
});

test('leaves every other status alone', () => {
  assert.equal(shouldOfferStopOrphansRetry(413, undefined, false), false);
  assert.equal(shouldOfferStopOrphansRetry(500, undefined, false), false);
  assert.equal(shouldOfferStopOrphansRetry(undefined, undefined, false), false);
});

test('never offers the retry when another transaction holds the connection', () => {
  assert.equal(shouldOfferStopOrphansRetry(409, 'IMPORT_NESTED_TRANSACTION', false), false);
});

test('an unknown future 409 code does not get the destructive retry', () => {
  // The non-offered branch is not silence — the caller still toasts the server's message — so the
  // safe default is to withhold a retry that stops live engines and replaces every table again.
  assert.equal(shouldOfferStopOrphansRetry(409, 'SOME_FUTURE_CODE', false), false);
});

test('only the 409 status can offer it, whatever the code says', () => {
  assert.equal(shouldOfferStopOrphansRetry(500, 'IMPORT_WOULD_ORPHAN_ENGINES', false), false);
});

// The assertion below guards the WIRING, which is this design's single point of failure. Matching the
// code positively means "no code" withholds the confirm — so if the api client ever stops copying the
// body's code onto the Error, every 409 arrives code-less, the predicate returns false for all of
// them, and the stop-orphans confirm becomes unreachable. It is the only control in the dashboard
// that can send stopOrphans, and nothing else in the suite would notice its loss: every test above
// hands the predicate a code directly.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the api client carries the machine code onto the error this predicate reads', () => {
  assert.match(
    read('../services/api.ts'),
    /err\.code = error\.code/,
    'api.ts must copy the response body `code` onto the thrown Error — update this guard, do not delete it',
  );
});
