/**
 * Escape one CSV cell for the audit-log and Number Checker exports.
 *
 * Two concerns, in order:
 * 1. Formula injection: a cell whose text begins with `=`, `+`, `-`, `@`, a tab or a carriage
 *    return is evaluated as a formula when the export is opened in a spreadsheet
 *    (Excel/LibreOffice/Sheets). Audit rows carry attacker-influenced strings (request paths,
 *    error messages, API-key names), so a logged request like `GET /=HYPERLINK("https://evil…")`
 *    would become a live formula in the operator's spreadsheet. Neutralize by prefixing an
 *    apostrophe: the spreadsheet then reads the value as text, and in a CSV file Excel shows the
 *    apostrophe itself. This mangles the export only (the dashboard UI shows the raw value).
 * 2. Structural quoting (pre-existing rule): a value containing `"`, `,`, a newline or a carriage
 *    return is wrapped in double quotes with inner quotes doubled.
 */
export function escapeCsvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
