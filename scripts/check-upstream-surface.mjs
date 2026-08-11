#!/usr/bin/env node
/**
 * Upstream capability-surface drift guard.
 *
 * Extracts the public capability surface of the two installed engines — whatsapp-web.js (Client
 * methods + Events values) and Baileys (Socket methods + BaileysEventMap events) — and compares it
 * against the committed snapshot (upstream-surface.snapshot.json). Any ADDED symbol is a capability
 * the gateway has never reviewed (the #1164 class of blindspot: group membership requests sat in
 * both engines, unreviewed, until a user asked); any REMOVED symbol is a capability an exposed
 * feature may silently depend on. Either fails `npm run test:scripts` until a maintainer reviews
 * the delta (classify it: expose / defer / exclude — the docs/29 + gap-matrix procedure) and
 * refreshes the snapshot with `node scripts/check-upstream-surface.mjs --update`.
 *
 * The extractors need not be perfect parsers: they only have to be DETERMINISTIC, because the check
 * compares this extractor's output today against the same extractor's committed output. A symbol
 * the regex cannot see today stays unseen on both sides; the moment an upstream bump makes it
 * visible, it shows up as an addition and gets its review.
 *
 * Same pattern as dockerfile-patchers.spec.js: a derived check over a surface that is otherwise
 * maintained by hand and forgotten by accident.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(ROOT, 'scripts', 'upstream-surface.snapshot.json');

/** Method names of the `Client` class block of whatsapp-web.js's index.d.ts. */
export function extractWwebjsClientMethods(dts) {
  const start = dts.indexOf('export class Client');
  if (start === -1) throw new Error('whatsapp-web.js index.d.ts: Client class not found');
  // The class body ends at the first closing brace back at 4-space indent.
  const end = dts.indexOf('\n    }', start);
  const block = dts.slice(start, end === -1 ? undefined : end);
  const names = new Set();
  for (const m of block.matchAll(/^ {8}(\w+)\(/gm)) names.add(m[1]);
  return [...names].sort();
}

/** Event VALUES of the Events constant in whatsapp-web.js's src/util/Constants.js. */
export function extractWwebjsEvents(constantsJs) {
  const start = constantsJs.indexOf('Events = {');
  if (start === -1) throw new Error('whatsapp-web.js Constants.js: Events block not found');
  const end = constantsJs.indexOf('};', start);
  const block = constantsJs.slice(start, end);
  const names = new Set();
  for (const m of block.matchAll(/^\s*[A-Z_0-9]+:\s*'([^']+)'/gm)) names.add(m[1]);
  return [...names].sort();
}

/** Socket method names across all of Baileys' lib/Socket/*.d.ts layer files. */
export function extractBaileysSocketMethods(dtsByFile) {
  const names = new Set();
  for (const dts of dtsByFile) {
    // Layer files type the socket as object literals whose members sit at 4-space indent:
    //   `groupMetadata: (jid: string) => Promise<GroupMetadata>;`  (also `<T>(...)` generics)
    for (const m of dts.matchAll(/^ {4}(\w+): (?:async )?[(<]/gm)) names.add(m[1]);
  }
  return [...names].sort();
}

/** Event names of the BaileysEventMap in lib/Types/Events.d.ts. */
export function extractBaileysEvents(dts) {
  const start = dts.indexOf('export type BaileysEventMap');
  if (start === -1) throw new Error('Baileys Events.d.ts: BaileysEventMap not found');
  const end = dts.indexOf('\n};', start);
  const block = dts.slice(start, end === -1 ? undefined : end);
  const names = new Set();
  for (const m of block.matchAll(/^ {4}'?([\w.-]+)'?:/gm)) names.add(m[1]);
  return [...names].sort();
}

export function extractSurface(root = ROOT) {
  const wwebjsDir = path.join(root, 'node_modules', 'whatsapp-web.js');
  const baileysDir = path.join(root, 'node_modules', '@whiskeysockets', 'baileys');
  const socketDir = path.join(baileysDir, 'lib', 'Socket');
  const socketDts = readdirSync(socketDir)
    .filter(f => f.endsWith('.d.ts'))
    .sort()
    .map(f => readFileSync(path.join(socketDir, f), 'utf8'));
  return {
    'whatsapp-web.js': {
      version: JSON.parse(readFileSync(path.join(wwebjsDir, 'package.json'), 'utf8')).version,
      clientMethods: extractWwebjsClientMethods(readFileSync(path.join(wwebjsDir, 'index.d.ts'), 'utf8')),
      events: extractWwebjsEvents(readFileSync(path.join(wwebjsDir, 'src', 'util', 'Constants.js'), 'utf8')),
    },
    baileys: {
      version: JSON.parse(readFileSync(path.join(baileysDir, 'package.json'), 'utf8')).version,
      socketMethods: extractBaileysSocketMethods(socketDts),
      events: extractBaileysEvents(readFileSync(path.join(baileysDir, 'lib', 'Types', 'Events.d.ts'), 'utf8')),
    },
  };
}

/** Diff two string arrays → {added, removed}; both empty means no drift. */
export function diffLists(current, committed) {
  const committedSet = new Set(committed);
  const currentSet = new Set(current);
  return {
    added: current.filter(s => !committedSet.has(s)),
    removed: committed.filter(s => !currentSet.has(s)),
  };
}

export function compareSurfaces(current, committed) {
  const problems = [];
  for (const [engine, lists] of [
    ['whatsapp-web.js', ['clientMethods', 'events']],
    ['baileys', ['socketMethods', 'events']],
  ]) {
    for (const list of lists) {
      const { added, removed } = diffLists(current[engine][list], committed[engine][list]);
      for (const s of added) problems.push(`${engine} ${list}: NEW upstream symbol '${s}' — unreviewed capability`);
      for (const s of removed) problems.push(`${engine} ${list}: symbol '${s}' GONE upstream — snapshot is stale`);
    }
  }
  return problems;
}

function main() {
  const surface = extractSurface();
  if (process.argv.includes('--update')) {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(surface, null, 2) + '\n');
    console.log(`✓ Snapshot refreshed at ${SNAPSHOT_PATH} — commit it together with the review that justified it`);
    return;
  }
  const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  const problems = compareSurfaces(surface, committed);
  const versionNote = ['whatsapp-web.js', 'baileys']
    .filter(e => surface[e].version !== committed[e].version)
    .map(e => `${e} ${committed[e].version} -> ${surface[e].version}`);
  if (problems.length === 0) {
    console.log(
      `✓ Upstream surface matches the reviewed snapshot` +
        (versionNote.length ? ` (version moved with an identical surface: ${versionNote.join(', ')})` : ''),
    );
    return;
  }
  console.error(`✗ Upstream capability surface drifted from the reviewed snapshot (${problems.length} symbol(s)):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nReview each symbol (expose it, defer it, or record the exclusion — see docs/29 and the gap-matrix ' +
      'procedure), then refresh the snapshot:\n  node scripts/check-upstream-surface.mjs --update\n',
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
