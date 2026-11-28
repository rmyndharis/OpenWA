/**
 * POST /infra/import-data answers 409 for unrelated reasons, and they need opposite handling.
 *
 * Exactly one of them is a DECISION the operator can act on: live engines exist for sessions the
 * backup would remove, and the documented retry is `stopOrphans=true`, which stops them inside the
 * request. That retry is destructive, so it is offered only for `IMPORT_WOULD_ORPHAN_ENGINES` —
 * matched POSITIVELY. The other refusals are "not now" answers (another restore is in flight,
 * another transaction holds the connection) where the only useful response is to wait and retry
 * unchanged; offering them the retry would run a second replace-all the operator never asked for,
 * from a dialog whose message says wait.
 *
 * Matching positively rather than excluding known codes is load-bearing. A 409 with no code is the
 * DEFAULT state, not evidence of the orphan case: a reverse proxy, a gateway error page or a body
 * that never parsed all produce one, and so would any refusal added later by an author who does not
 * know a destructive confirm keys on this. Withholding costs only the retry button: where the body
 * survived, the error toast still carries the server's own message; where it did not, there was no
 * message to lose and the alternative was offering a destructive OK under a bare "HTTP 409".
 *
 * A gateway older than this code refuses orphans without the code, so a split-origin dashboard
 * (VITE_API_URL) pointed at one withholds the confirm for a legitimate orphan refusal. That
 * degradation is deliberate and recoverable — the message still says to stop the sessions first.
 * The backend pins its half of the contract in the infra-data controller spec.
 */
export function shouldOfferStopOrphansRetry(
  status: number | undefined,
  code: string | undefined,
  alreadyRetriedWithStopOrphans: boolean,
): boolean {
  if (status !== 409) return false;
  // A 409 on the retry itself (an engine started mid-import) must not loop.
  if (alreadyRetriedWithStopOrphans) return false;
  return code === 'IMPORT_WOULD_ORPHAN_ENGINES';
}

/**
 * The translation key for a refusal the dashboard explains in its own words, or undefined to show the gateway's
 * message. 503 IMPORT_STOPPED: the gateway stopped while a SQLite restore ran and rolled it back, so nothing changed
 * and the same file can be imported again once it is back. A 503 without that code (a proxy, a draining gateway)
 * keeps its own message.
 */
export function importRefusalMessageKey(status: number | undefined, code: string | undefined): string | undefined {
  return status === 503 && code === 'IMPORT_STOPPED' ? 'infrastructure.migration.importStopped' : undefined;
}
