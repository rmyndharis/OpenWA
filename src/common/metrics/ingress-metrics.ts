// Process-lifetime total; no provider payloads or unbounded identity labels are retained.
let bodyMismatchTotal = 0;

export function incrementIngressDedupBodyMismatches(): void {
  bodyMismatchTotal += 1;
}

export function getIngressDedupBodyMismatchesTotal(): number {
  return bodyMismatchTotal;
}
