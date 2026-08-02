import type { StatsPeriod } from '../services/api';

// Stable, distinct color per message type. Keyed by type name — not array index — so two types
// can never share a color, and a slice keeps its color even when the set of present types changes.
const TYPE_COLORS: Record<string, string> = {
  text: '#25d366',
  image: '#3b82f6',
  contact: '#a855f7',
  document: '#f59e0b',
  audio: '#06b6d4',
  voice: '#ec4899',
  video: '#14b8a6',
  sticker: '#ef4444',
  location: '#84cc16',
  poll: '#6366f1',
  revoked: '#f43f5e',
  masked: '#8b5cf6',
  unknown: '#64748b',
};

const FALLBACK_COLORS = ['#0ea5e9', '#d946ef', '#f97316', '#10b981', '#6366f1', '#eab308'];

/** Deterministic color for a message-type name. Known types get a stable brand color; unknown
 *  types get a hash-based deterministic fallback so the color never changes between renders. */
export function colorForType(name: string): string {
  if (TYPE_COLORS[name]) return TYPE_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

/** Format a timestamp string for the chart axis. '2026-06-24 14:00:00' (hour buckets) → '14:00';
 *  '2026-06-24' or '2026-06-24 00:00:00' (day buckets) → '06-24'. */
export function formatTick(ts: string, period: StatsPeriod): string {
  if (period === '24h') return ts.slice(11, 16);
  // Strip any trailing time component so '2026-12-31 00:00:00' → '12-31'.
  const datePart = ts.includes(' ') ? ts.slice(0, 10) : ts;
  return datePart.slice(5);
}

/** WhatsApp ids look like '62812...@c.us' / '...@g.us' / '...@lid' — show just the local part. */
export function shortChat(chatId: string): string {
  return chatId.split('@')[0] || chatId;
}