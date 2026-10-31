/**
 * Make a failed whatsapp-web.js send report what the page actually threw.
 *
 * `Client.sendMessage` runs the send inside `page.evaluate`, and puppeteer rebuilds a page-side
 * exception in Node from two CDP fields only, the class name and the description
 * (puppeteer-core `cdp/utils.js` `createEvaluationError`). WhatsApp Web's own error classes are
 * minified to a one-letter name and keep their detail in their own properties rather than in
 * `message`, so a send the page refuses (`MediaFileTooLarge`, `InvalidMediaCheckRepairFailedType`)
 * reaches OpenWA as `t: t` with nothing but Node frames. The warning a failed send logs then names
 * no cause, and neither does anything the operator can send upstream (#1679).
 *
 * The patch wraps the one `window.WWebJS.sendMessage` call inside that evaluate. A plain Error is
 * rethrown untouched, for the reasons given at FIX. Any other thrown value is rethrown as a plain
 * Error whose message is PREFIX followed by a JSON summary read inside the page: the WhatsApp Web
 * build that is actually running, the constructor name, `String()`, `name`, `message`, `stack`, and
 * the value's own properties. The build is read from the page because the one OpenWA pins is not
 * always the one that runs: a warm profile's service worker can serve a newer build under the pin.
 *
 * Diagnostic only. A send that succeeds returns exactly what it returned before, and a send that
 * fails still fails; only the text of the failure changes. `getChat`, `sendSeen` and
 * `getMessageModel` stay outside the wrap, so their failures reach Node exactly as before.
 *
 * PREFIX is shared with `src/engine/adapters/wwebjs-lifecycle.ts` (CAPTURED_PAGE_ERROR_PREFIX),
 * whose dead-page classifier must never read a captured error as a transport death: the summary
 * quotes WhatsApp Web's own text, which can mention a closed connection while the page is plainly
 * alive. `wwebjs-send-page-error.spec.ts` pins the two constants equal.
 *
 * The source transform is deliberately exact and self-disabling, like the sibling patchers. An
 * unknown shape fails the production image build instead of silently shipping without it, and the
 * patch stands down once the installed tree carries it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** The start of every message this patch builds. Kept identical to the manual patch posted on #1679. */
const PREFIX = 'page threw ';

// The send call inside Client.sendMessage's page.evaluate and the line that consumes its result,
// unique in the file. Neither the #201832 backport nor the ready-sync patch touches these lines.
const ANCHOR = `                const msg = await window.WWebJS.sendMessage(
                    chat,
                    content,
                    options,
                );
                return msg ? window.WWebJS.getMessageModel(msg) : undefined;
`;

// A plain Error (`e.constructor === Error`) passes through as the SAME object. That is what the send
// path's readable failures already are: whatsapp-web.js's own throws (`Could not get the quoted
// message.`, `media-fault: ...`) and WhatsApp Web's bare `No LID for user`, which puppeteer rebuilds
// readably, message and page frames included. OpenWA matches them by substring
// (isNoLidForUserError, isQuoteUnresolvedError) and the dead-page classifier reads the same text, so
// handing them over byte-identical is what guarantees none of those decisions can change.
// Everything else is captured: WhatsApp Web's own subclasses, which arrive as `t: t`; primitives,
// which arrive as a bare value with no stack; objects puppeteer cannot describe (a null prototype, a
// hostile Proxy), which arrive as `Protocol error (Runtime.callFunctionOn): Internal error` and so
// read as a dead page; and native subclasses such as TypeError, which arrive readable today and gain
// the running build and their own properties.
//
// Every read of the thrown value is guarded, because it can be anything: a primitive, `undefined`, a
// null-prototype object, a throwing getter, a Proxy whose traps throw, or a cycle. Each field is cut
// to 500 characters and every field and property name shares a 2000-character budget, so a thrown
// object carrying a large buffer or thousands of properties cannot turn one failed send into a
// multi-kilobyte log line, bulk result or hook payload. The budget is charged in what the JSON
// spends, not in raw characters: escaping writes a control character as six, and each property
// adds its quotes, colon and comma, so counting the raw text let the message reach several times
// the budget.
const FIX = `                let msg;
                try {
                    msg = await window.WWebJS.sendMessage(
                        chat,
                        content,
                        options,
                    );
                } catch (e) {
                    let plain = false;
                    try {
                        plain = e instanceof Error && e.constructor === Error;
                    } catch {
                        plain = false;
                    }
                    if (plain) throw e;
                    let budget = 2000;
                    // The longest start of text whose JSON encoding, quotes aside, fits in room.
                    const fit = (text, room) => {
                        let cut = text.slice(0, room);
                        while (JSON.stringify(cut).length - 2 > room) cut = cut.slice(0, -1);
                        return cut;
                    };
                    const read = (get) => {
                        let text;
                        try {
                            text = String(get());
                        } catch {
                            text = '(unreadable)';
                        }
                        text = fit(text, Math.max(0, Math.min(500, budget)));
                        budget -= JSON.stringify(text).length;
                        return text;
                    };
                    const info = {
                        build: read(() => window.Debug.VERSION),
                        ctor: read(() => e.constructor.name),
                        str: read(() => e),
                        name: read(() => e.name),
                        message: read(() => e.message),
                        stack: read(() => e.stack),
                    };
                    let keys = [];
                    try {
                        keys = Object(e) === e ? Object.getOwnPropertyNames(e) : [];
                    } catch {
                        info.props = '(unreadable)';
                    }
                    for (const key of keys) {
                        if (budget <= 0) break;
                        if (key in info) continue;
                        const name = fit(key, Math.min(100, budget));
                        // The name in quotes, then its colon and comma.
                        budget -= JSON.stringify(name).length + 2;
                        info[name] = read(() => e[key]);
                    }
                    throw new Error('${PREFIX}' + JSON.stringify(info));
                }
                return msg ? window.WWebJS.getMessageModel(msg) : undefined;
`;

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyBackport(wwjsDir = DEFAULT_WWJS) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  }

  const source = fs.readFileSync(clientFile, 'utf8');
  const anchorCount = occurrences(source, ANCHOR);
  const fixCount = occurrences(source, FIX);

  if (anchorCount === 0 && fixCount === 1) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already reports page-side send errors',
    };
  }
  if (anchorCount !== 1 || fixCount !== 0) {
    throw new Error(
      `unsupported Client.js shape (anchors: ${anchorCount}, fixes: ${fixCount}); ` +
        're-evaluate the send error capture against the installed whatsapp-web.js',
    );
  }

  writeFileAtomic(clientFile, source.replace(ANCHOR, FIX));
  return { skipped: false, note: 'page-side send errors now carry what the page threw' };
}

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const source = fs.readFileSync(path.join(wwjsDir, CLIENT_PATH), 'utf8');
    return occurrences(source, ANCHOR) === 0 && occurrences(source, FIX) === 1;
  } catch {
    return true;
  }
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyBackport();
    console.log(`patch-wwebjs-send-error: ${result.skipped ? `skipped: ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-send-error: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-send-error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyBackport, isApplied, ANCHOR, FIX, PREFIX };
