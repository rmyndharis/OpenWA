#!/usr/bin/env node
/**
 * SDK webhook-event guard.
 *
 * Each typed SDK restates the webhook event list as a union, a Literal, a constant block or an enum.
 * Nothing compared any of them to the gateway, so an event added to `WEBHOOK_EVENTS` shipped with
 * four SDKs that could not name it: the subscription is valid, the server dispatches it, and a typed
 * client rejects the string at compile time. That is how `group.join_request` sat unlisted in all
 * four while `openapi.json` published it.
 *
 * SCOPE, stated so the guarantee is not read wider than it is:
 *   - Covers JavaScript, Python, Go and Java, which all enumerate the events somewhere.
 *   - Does NOT cover PHP, which takes the event as a plain string and enumerates nothing.
 *   - Compares the SET of event names, not their order or their identifier spellings.
 *
 * Lives in ci.yml's lint job rather than sdk-ci.yml for the same reason as the route guard:
 * sdk-ci is path-filtered and does not list openapi.json, so changing the contract alone runs none
 * of it, and it never runs on a release tag.
 *
 * Run locally: `npm run check:sdk-events`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the latter stays percent-encoded, so a checkout under a path
// containing a space resolves to a directory that does not exist and every read here fails with
// ENOENT. check-sdk-docs.mjs and check-chart-behaviour.mjs already resolve it this way.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const contract = JSON.parse(read('openapi.json'));
const expected = new Set(contract.components.schemas.CreateWebhookDto.properties.events.items.enum);

/** Harvest by the shape each SDK actually writes, rather than by a shared convention they lack. */
const SDKS = [
  {
    name: 'javascript',
    file: 'sdk/javascript/src/types.ts',
    // `export type WebhookEvent =` followed by `| 'name'` members.
    harvest: text => {
      const union = text.slice(text.indexOf('export type WebhookEvent ='));
      return [...union.slice(0, union.indexOf(';')).matchAll(/'([^']+)'/g)].map(m => m[1]);
    },
  },
  {
    name: 'python',
    file: 'sdk/python/openwa/types.py',
    harvest: text => {
      const literal = text.slice(text.indexOf('WebhookEvent = Literal['));
      return [...literal.slice(0, literal.indexOf(']')).matchAll(/"([^"]+)"/g)].map(m => m[1]);
    },
  },
  {
    name: 'go',
    file: 'sdk/go/types_webhook.go',
    harvest: text => [...text.matchAll(/^\s*Event\w+\s+WebhookEvent = "([^"]+)"$/gm)].map(m => m[1]),
  },
  {
    name: 'java',
    file: 'sdk/java/src/main/java/com/rmyndharis/openwa/model/WebhookEvent.java',
    harvest: text => [...text.matchAll(/@SerializedName\("([^"]+)"\)/g)].map(m => m[1]),
  },
];

const errors = [];
for (const sdk of SDKS) {
  const found = new Set(sdk.harvest(read(sdk.file)));

  // A pattern that silently stopped matching would make this gate vacuous, so an empty or
  // implausibly small harvest is a failure rather than a pass.
  if (found.size < expected.size - 5) {
    errors.push(`${sdk.name}: harvested only ${found.size} events from ${sdk.file} — the scan pattern has drifted.`);
    continue;
  }

  for (const event of [...expected].sort()) {
    if (!found.has(event)) errors.push(`${sdk.name}: does not list "${event}", which the gateway accepts and dispatches.`);
  }
  for (const event of [...found].sort()) {
    if (!expected.has(event)) errors.push(`${sdk.name}: lists "${event}", which is not in the contract.`);
  }
}

if (errors.length) {
  console.error('\n✖ SDK webhook events drifted from the committed contract:');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nAdd the event to the SDK, or regenerate the contract (`npm run openapi:export`).\n');
  process.exit(1);
}
console.log(`✓ SDK webhook events OK (${expected.size} contract events across ${SDKS.length} SDKs).`);
