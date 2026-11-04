import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A control that is invisible until :hover is never seen on a touch screen, which has no hover: on a phone the
// per-row chat menu (pin, mute, archive, delete) could not be found from the list. Where there is no hover the
// trigger stays visible.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pages/Chats.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

// The bodies of every @media block whose condition is `query`, found by matching braces.
function mediaBody(query: string): string {
  const bodies: string[] = [];
  for (let at = css.indexOf(`@media ${query}`); at !== -1; at = css.indexOf(`@media ${query}`, at + 1)) {
    const open = css.indexOf('{', at);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    bodies.push(css.slice(open + 1, i - 1));
  }
  assert.notEqual(bodies.length, 0, `Chats.css has no @media ${query}`);
  return bodies.join('\n');
}

test('the chat row menu trigger stays visible where there is no hover', () => {
  assert.match(
    css,
    /\.chats-page \.chat-row-menu-trigger\s*\{[^}]*opacity:\s*0\s*;/,
    'the trigger is no longer hidden by default',
  );
  const rule = /\.chats-page \.chat-row-menu-trigger\s*\{([^}]*)\}/.exec(mediaBody('(hover: none)'));
  assert.ok(rule, 'no trigger rule under (hover: none)');
  assert.match(rule[1], /opacity:\s*1/);
});

// The message actions (reply, react, delete) show on hover or keyboard focus. A touch screen reveals them with a tap,
// which iOS turns into hover only on an element it takes for clickable: the bubble container is marked so there.
test('a tap reveals the message actions on a touch screen, as hover does with a mouse', () => {
  assert.match(
    css,
    /\.chats-page \.message-bubble-container:hover \.message-actions-menu/,
    'the actions are no longer revealed by hovering their message',
  );
  const rule = /\.chats-page \.message-bubble-container\s*\{([^}]*)\}/.exec(mediaBody('(hover: none)'));
  assert.ok(rule, 'no message rule under (hover: none)');
  assert.match(rule[1], /cursor:\s*pointer/, 'iOS gives no hover to a tap on a message it does not take for clickable');
});
