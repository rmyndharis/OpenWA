/**
 * Process-lifetime count of promise rejections that reached the process-level backstop
 * (`registerUnhandledRejectionHandler`), split by the handler's own classification so an alert can
 * target `other` without firing on the expected whatsapp-web.js navigation rejections.
 */
export type UnhandledRejectionKind = 'page_context_lost' | 'other';

const unhandledRejections: Record<UnhandledRejectionKind, number> = { page_context_lost: 0, other: 0 };

export function incrementUnhandledRejections(kind: UnhandledRejectionKind): void {
  unhandledRejections[kind] += 1;
}

export function getUnhandledRejections(): Readonly<Record<UnhandledRejectionKind, number>> {
  return { ...unhandledRejections };
}
