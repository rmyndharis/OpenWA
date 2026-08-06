/**
 * Copy text to the clipboard, returning whether it succeeded.
 *
 * The async Clipboard API is only available in a secure context (HTTPS / localhost). Over plain
 * HTTP on a LAN IP `navigator.clipboard` is undefined (and can also reject on permission denial),
 * so fall back to a hidden textarea + `execCommand('copy')` instead of throwing (#244).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path (e.g. NotAllowedError outside a user gesture).
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
