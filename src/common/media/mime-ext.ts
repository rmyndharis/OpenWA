/** Subtypes whose registered mimetype name differs from the conventional file extension. */
const MIME_SUBTYPE_EXT_OVERRIDES: Record<string, string> = { jpeg: 'jpg', quicktime: 'mov' };

/** File extension to store a media blob under, derived from its mimetype; 'bin' when unrecognized. */
export function extFromMimetype(mimetype: string): string {
  const subtype = mimetype.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (!subtype || !/^[a-z0-9]+$/.test(subtype)) return 'bin';
  // Own keys only: 'constructor' is a legal subtype and an inherited member would come back as the extension.
  return Object.hasOwn(MIME_SUBTYPE_EXT_OVERRIDES, subtype) ? MIME_SUBTYPE_EXT_OVERRIDES[subtype] : subtype;
}
