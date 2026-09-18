import type { BulkMediaPayload, BulkMessageItem } from '../services/api';

export type BulkMediaKind = 'image' | 'video' | 'audio' | 'document';

export const BULK_MEDIA_KINDS: readonly BulkMediaKind[] = ['image', 'video', 'audio', 'document'];

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
  if (!file && !trimmedUrl) return null;
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
