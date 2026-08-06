/**
 * Type-level contract test for the engine-resource endpoints — `tsc` is the gate, which `npm test`
 * runs ahead of vitest (`.test-d.ts` sits outside vitest's `test/**\/*.test.ts` include, so there is
 * no suite to run here; the build tsconfigs exclude `test/`, so nothing else would check it).
 *
 * The status/label/channel routes hand the engine-neutral shapes from
 * `src/engine/interfaces/whatsapp-engine.interface.ts` straight to the client — no DTO, no remap —
 * so the record types below must mirror those shapes as JSON. Nothing else enforces that: the
 * controllers declare no `@ApiResponse` type, so `openapi.json` carries no schema for these routes
 * and `openapi:check` has nothing to diff, and the resource tests mock the transport and assert
 * URLs only (#754).
 *
 * The `Wire*` types are the server interfaces as they arrive over JSON — `Date` fields serialize to
 * ISO strings, everything else is verbatim. Keep them in sync with the engine interface by hand;
 * `sdk-ci.yml` re-runs this job when that file changes.
 * @packageDocumentation
 */

import type { CatalogInfo, ChannelMessageRecord, ChannelRecord, LabelRecord, StatusRecord } from '../src/types.js';

/** `Label` — `hexColor` is the only colour field the wire shape carries. */
interface WireLabel {
  id: string;
  name: string;
  hexColor: string;
}

/**
 * `Status` — `timestamp`/`expiresAt` are `Date` on the server and ISO strings once serialized.
 * `mediaUrl`/`backgroundColor`/`font` are declared by the engine interface but no adapter populates
 * them yet (wwjs `collectStatuses()` sets neither; Baileys throws `unsupported`), so they are
 * optional here for forward-compatibility rather than because a response carries them today.
 */
interface WireStatus {
  id: string;
  contact: { id: string; name?: string; pushName?: string };
  type: 'text' | 'image' | 'video';
  caption?: string;
  mediaUrl?: string;
  backgroundColor?: string;
  font?: number;
  timestamp: string;
  expiresAt: string;
}

/** `Channel` — `picture`/`createdAt` come from the Baileys `toChannel()` path; wwjs omits both. */
interface WireChannel {
  id: string;
  name: string;
  description?: string;
  inviteCode?: string;
  subscriberCount?: number;
  picture?: string;
  verified?: boolean;
  createdAt?: number;
}

/** `ChannelMessage` — the live engine payload, NOT the persisted `MessageRecord`. */
interface WireChannelMessage {
  id: string;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  mediaUrl?: string;
}

/** `Catalog` — the control: this pair already agreed before #754 and must stay agreeing. */
interface WireCatalog {
  id: string;
  name: string;
  description?: string;
  productCount: number;
  url: string;
}

/**
 * Resolves to `true` only when `Rec` is an honest view of `Wire`: it can hold every real response
 * (so no field access that the server answers is a compile error), and it declares no field the
 * server never sends (so no access silently evaluates to `undefined`). A mismatch resolves to a
 * message tuple, which fails to accept `true` at the assertion site.
 */
type Mirrors<Wire, Rec> = Wire extends Rec
  ? [Exclude<keyof Wire, keyof Rec>] extends [never]
    ? [Exclude<keyof Rec, keyof Wire>] extends [never]
      ? true
      : ['sdk declares fields the server never sends:', Exclude<keyof Rec, keyof Wire>]
    : ['sdk omits fields the server sends:', Exclude<keyof Wire, keyof Rec>]
  : ['sdk type cannot hold a real response:', Wire];

const label: Mirrors<WireLabel, LabelRecord> = true;
const status: Mirrors<WireStatus, StatusRecord> = true;
const channel: Mirrors<WireChannel, ChannelRecord> = true;
const channelMessage: Mirrors<WireChannelMessage, ChannelMessageRecord> = true;
const catalog: Mirrors<WireCatalog, CatalogInfo> = true;

export const contract = [label, status, channel, channelMessage, catalog];
