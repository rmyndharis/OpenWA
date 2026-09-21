import type { BulkMediaPayload, BulkMessageItem } from '../services/api';

export type BulkMediaKind = 'image' | 'video' | 'audio' | 'document';

export const BULK_MEDIA_KINDS: readonly BulkMediaKind[] = ['image', 'video', 'audio', 'document'];

// Total base64 across all items: the default 25 MB BODY_SIZE_LIMIT minus room for the JSON envelope.
// A gateway running with a lower BODY_SIZE_LIMIT rejects smaller requests, which the dashboard can't know.
export const BULK_INLINE_MEDIA_MAX_BYTES = 24 * 1024 * 1024;

export const BULK_CAPTION_MAX_LENGTH = 1024;

export interface BulkAttachment {
  kind: BulkMediaKind;
  media: BulkMediaPayload;
}

const KIND_BY_EXTENSION: Record<string, BulkMediaKind> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  mp4: 'video',
  mov: 'video',
  '3gp': 'video',
  mkv: 'video',
  webm: 'video',
  mp3: 'audio',
  ogg: 'audio',
  opus: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wav: 'audio',
};

// The server treats a media string as a URL only when it starts with http:// or https:// and decodes
// anything else as base64. A URL parser alone repairs `https:/host/a.pdf` or `https:host/a.pdf`, so the
// raw string has to carry the prefix too, or those typos go out as a file of garbage bytes.
export function isHttpMediaUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Caption length the way the server's @MaxLength counts it (validator.js isLength): a surrogate pair
// is one character and a variation selector is none, so an emoji does not count twice.
export function captionLength(text: string): number {
  const surrogatePairs = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  const presentationSequences = text.match(/[^️︎][️︎]/g)?.length ?? 0;
  return text.length - presentationSequences - surrogatePairs;
}

export function inlineMediaBudgetBytes(recipientCount: number): number {
  return Math.floor((BULK_INLINE_MEDIA_MAX_BYTES / Math.max(recipientCount, 1)) * 0.75);
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
  return `${Math.max(1, Math.floor(bytes / 1024))} KB`;
}

export function mediaKindFromMime(mimetype: string): BulkMediaKind {
  const category = mimetype.split('/')[0]?.toLowerCase();
  return category === 'image' || category === 'video' || category === 'audio' ? category : 'document';
}

export function filenameFromUrl(url: string): string | undefined {
  let lastSegment: string | undefined;
  try {
    lastSegment = new URL(url).pathname.split('/').pop();
  } catch {
    return undefined;
  }
  if (!lastSegment) return undefined;
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

export function mediaKindFromUrl(url: string): BulkMediaKind {
  const filename = filenameFromUrl(url.trim());
  const extension = filename?.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  return (extension && KIND_BY_EXTENSION[extension]) || 'document';
}

export function toBulkAttachment(
  kind: BulkMediaKind,
  file: { base64: string; mimetype: string; filename: string } | null,
  url: string,
): BulkAttachment | null {
  const trimmedUrl = url.trim();
  if (!file && !isHttpMediaUrl(trimmedUrl)) return null;
  const media: BulkMediaPayload = file ? { base64: file.base64, mimetype: file.mimetype } : { url: trimmedUrl };
  if (kind === 'document') {
    const filename = file ? file.filename : filenameFromUrl(trimmedUrl);
    if (filename) media.filename = filename;
  }
  return { kind, media };
}

export function buildBulkMessages(
  chatIds: readonly string[],
  text: string,
  attachment: BulkAttachment | null,
): BulkMessageItem[] {
  return chatIds.map(chatId => {
    if (!attachment) return { chatId, type: 'text', content: { text } };
    const content: BulkMessageItem['content'] = text.trim() ? { caption: text } : {};
    content[attachment.kind] = attachment.media;
    return { chatId, type: attachment.kind, content };
  });
}
