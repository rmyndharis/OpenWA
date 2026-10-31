import { normalizePhoneText } from './phone.ts';

// The backend caps a bulk batch at 100 messages (ArrayMaxSize on SendBulkMessageDto).
export const BULK_MAX_RECIPIENTS = 100;

// Pre-read cap for the recipients file picker. A phone list is bytes, not media: 2 MiB is roughly
// 100k entries, far past the batch cap, while still stopping a mistaken multi-hundred-MB pick from
// being materialized as a JS string before the textarea ever sees it (same shape as the media
// upload's pre-read check in MessageTester).
export const BULK_RECIPIENTS_FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Parse the bulk-recipients textarea into chat IDs: trims whitespace, drops blanks, de-dupes, and
 * normalizes bare phone numbers to `<digits>@c.us`. An entry with a WhatsApp chat id shape passes
 * through untouched; any other entry containing '@', such as an email column, is dropped. Anything
 * else must carry at least MIN_PHONE_DIGITS digits or it is dropped rather than sent as a
 * meaningless or truncated id.
 *
 * Entries are separated by line endings AND by the comma/semicolon/tab a spreadsheet export writes,
 * because the file picker offers `.csv`. Phone-number formatting (spaces, parentheses, hyphens,
 * a leading plus) is not a separator and is stripped within one entry.
 *
 * All three line endings are accepted. A textarea normalizes CR and CRLF to LF in its own value, but
 * an uploaded file does not go through one: FileReader hands the bytes over as written, so a file
 * saved with classic Mac endings arrives as a single bare-CR line.
 */
/**
 * Field separators a spreadsheet export uses, and the Arabic comma and semicolon (the full-width ones are folded to
 * these ASCII ones before the split). Deliberately NOT space, parentheses or hyphen: those
 * are phone-number formatting (`+1 (555) 010-2233` is one entry, not five), and no WhatsApp chat id
 * shape contains a comma, a semicolon or a tab.
 */
const FIELD_SEPARATORS = /[,;\t\u060C\u061B]/;

// A quote at the edge of a field is the CSV quoting of a cell, never part of a chat id: `"123@g.us"` is the chat id
// 123@g.us. Quotes are not tracked across fields or lines, so one that never closes cannot swallow what follows it.
const stripEdgeQuotes = (field: string): string => field.replace(/^"/, '').replace(/"$/, '').trim();

/**
 * Fewest digits a bare number may carry to be treated as a phone number, matching the bound the
 * gateway and the session form already enforce (`/^[0-9]{6,15}$/`).
 *
 * It exists because of the separator split above. A spreadsheet row like `1,628123456789` yields an
 * index column alongside the number, and without a floor that `1` would ship as `1@c.us`.
 */
const MIN_PHONE_DIGITS = 6;

/**
 * Most digits a phone number has (E.164). Spaces are formatting inside one number, so two whole numbers on one line
 * fold into one run of digits; a run past this bound is no number anybody typed and is dropped, never sent. A leading
 * 00 is not stripped here, so a 00-prefixed number of 15 digits is dropped too rather than sent with its exit code.
 */
const MAX_PHONE_DIGITS = 15;

/**
 * A full chat id: a numeric user part (a device suffix or group hyphen allowed) on a WhatsApp
 * server. The server list is what keeps an email out; a numeric local part alone would still let
 * `12345@qq.com` through.
 */
const CHAT_ID = /^[0-9][0-9:-]*@(c\.us|g\.us|s\.whatsapp\.net|lid|newsletter|broadcast)$/i;

export function parseBulkRecipients(text: string): string[] {
  const seen = new Set<string>();
  // Folded before the split, so a list in the digits and the commas of another script is split as it reads.
  for (const rawLine of normalizePhoneText(text).split(/\r\n?|\n/)) {
    // Split into fields before anything else. The button offers `.csv`, and a row with more than one
    // column used to have its columns' digits CONCATENATED by the strip below: `1,628123456789`
    // became `1628123456789@c.us`, a different number that looks entirely plausible in the
    // recipients box. Splitting first keeps each column a candidate on its own.
    for (const rawField of rawLine.split(FIELD_SEPARATORS)) {
      const field = rawField.trim();
      if (!field) continue;
      if (field.includes('@')) {
        const id = stripEdgeQuotes(field);
        if (CHAT_ID.test(id)) seen.add(id);
        continue;
      }
      const digits = field.replace(/[^0-9]/g, '');
      if (digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS) seen.add(`${digits}@c.us`);
    }
  }
  return [...seen];
}
