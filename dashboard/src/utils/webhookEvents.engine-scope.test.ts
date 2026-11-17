import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// whatsapp-web.js has no callback behind event.response, call.accepted, call.rejected and call.missed: a webhook
// subscribes to them without an error and they never fire (docs/06, the events list of the webhook routes). The
// reference list on the Webhooks page is where an operator picks events, and it already says so for message.receipt.
// The four that fail silently have to say it too, in the words each catalogue uses for that note ("Baileys only",
// "nur Baileys", "Baileys 전용").
const dir = new URL('../i18n/locales/', import.meta.url);
const descriptionsOf = (file: string): Record<string, string> =>
  (JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { webhooks: { eventDescriptions: Record<string, string> } })
    .webhooks.eventDescriptions;

// The phrase the note of message.receipt opens with, in whatever parentheses and script the catalogue writes it.
const engineNote = (receipt: string): string | undefined =>
  /[(（]([^;；,，؛)）]*Baileys[^;；,，؛)）]*)/.exec(receipt)?.[1].trim();

const SILENT = ['event.response', 'call.accepted', 'call.rejected', 'call.missed'];

test('an event whatsapp-web.js subscribes to and never fires carries the engine note, in every catalogue', () => {
  assert.equal(engineNote(descriptionsOf('en.json')['message.receipt']), 'Baileys only');
  const files = readdirSync(dir).filter(file => file.endsWith('.json'));
  assert.ok(files.length >= 15, 'the catalogues moved');
  const missing: string[] = [];
  for (const file of files) {
    const descriptions = descriptionsOf(file);
    const note = engineNote(descriptions['message.receipt']);
    assert.ok(note, `${file}: message.receipt has no engine note to reuse`);
    for (const name of SILENT) {
      if (!descriptions[name]?.includes(note)) missing.push(`${file}:${name}`);
    }
  }
  assert.equal(
    missing.length,
    0,
    `${missing.length} descriptions leave a whatsapp-web.js operator subscribed to a dead event: ${missing.slice(0, 5).join(', ')}`,
  );
});

test('an event both engines fire does not carry the engine note', () => {
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const descriptions = descriptionsOf(file);
    const note = engineNote(descriptions['message.receipt']) as string;
    for (const name of ['call.received', 'poll.vote', 'message.received', 'group.join_request']) {
      assert.equal(descriptions[name].includes(note), false, `${file}:${name} claims to be Baileys only`);
    }
  }
});
