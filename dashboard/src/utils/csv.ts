/**
 * Escape one CSV cell for the audit-log export.
 *
 * Two concerns, in order:
 * 1. Formula injection: a cell whose text begins with `=`, `+`, `-`, or `@` is evaluated as a
 *    formula when the export is opened in a spreadsheet (Excel/LibreOffice/Sheets). Audit rows
 *    carry attacker-influenced strings (request paths, error messages, API-key names), so a
 *    logged request like `GET /=HYPERLINK("https://evil…")` would become a live formula in the
 *    operator's spreadsheet. Neutralize by prefixing an apostrophe — the spreadsheet then shows
 *    the value as text. This mangles the export only (the dashboard UI shows the raw value).
 * 2. Structural quoting (pre-existing rule): a value containing `"`, `,` or a newline is
 *    wrapped in double quotes with inner quotes doubled.
 */
export function escapeCsvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
