/** The modal's confirm-button label on an English WhatsApp Web. */
export const ONBOARDING_DEFAULT_CONTINUE_LABEL = 'Continue';

/**
 * Extra confirm-button labels for a deployment whose WhatsApp Web does not render this modal in
 * English, comma-separated (`WWEBJS_ONBOARDING_CONTINUE_LABELS=Continuar,Weiter`).
 *
 * Needed because the match is on visible text and WhatsApp controls those strings — we are not going
 * to carry its translation table. Read per probe, not cached, so an operator can correct a running
 * deployment through the infra config without a restart.
 *
 * Supplying labels also drops the heading requirement for THOSE labels: the English heading regex
 * would reject a localised modal anyway, so requiring both would make the setting useless. That is a
 * deliberate, operator-opted-in loosening — see {@link probeOnboardingModal}.
 */
export function resolveOnboardingContinueLabels(): string[] {
  const extra = (process.env.WWEBJS_ONBOARDING_CONTINUE_LABELS ?? '')
    .split(',')
    .map(label => label.trim())
    .filter(Boolean);
  return [ONBOARDING_DEFAULT_CONTINUE_LABEL, ...extra];
}

/**
 * In-page probe for the onboarding modal: click its confirm button if it is on screen.
 *
 * Exported and self-contained on purpose. `page.evaluate` stringifies this into the browser, so it
 * may not close over anything in this module — every input arrives as an argument — and being a plain
 * function means the DOM matching can be unit-tested directly, rather than only through a mocked
 * `evaluate` that proves nothing about the matching itself.
 *
 * The BUTTON is the presence signal, never the heading text on its own. `textContent` on a `div`
 * concatenates every descendant, so a chat-list row previewing the words "what's new" — an ordinary
 * English message — satisfies a heading-only test. Treating that as a stuck modal would take a
 * perfectly healthy session out of READY and block every send. A visible control whose exact label is
 * the confirm label, sitting within a few levels of an element that also carries the heading, is a
 * shape the chat list does not produce. The ancestor walk is bounded for the same reason: matching
 * against `<body>` would just be the loose text test again.
 *
 * LANGUAGE. The default label and the heading are English, and the modal is rendered in whatever
 * language WhatsApp Web decides. Two things address that, both defaulting to today's behaviour:
 * the launch args pin `--lang` so the page has a deterministic locale, and an operator can add
 * their own labels (see {@link resolveOnboardingContinueLabels}). An operator-supplied label matches
 * WITHOUT the heading check — the English heading would reject a localised modal regardless, so
 * requiring both would make the setting inert. The default `Continue` keeps the heading requirement,
 * so the out-of-the-box false-positive surface is unchanged.
 */
export function probeOnboardingModal(options?: { labels?: string[]; headingOptionalFor?: string[] }): {
  modalPresent: boolean;
  dismissed: boolean;
} {
  const isVisible = (el: Element): boolean => {
    const rect = (el as HTMLElement).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (el as HTMLElement).offsetParent !== null;
  };
  const labels = options?.labels?.length ? options.labels : ['Continue'];
  const headingOptional = new Set(options?.headingOptionalFor ?? []);
  // Both apostrophes: WhatsApp Web renders the typographic U+2019, and an ASCII quote appears in
  // older builds. Matching only the ASCII form means never recognising the real modal.
  const heading = /what[’']?s new/i;
  const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
    .map(el => ({ el, label: (el.textContent || '').trim() }))
    .filter(c => isVisible(c.el) && labels.includes(c.label));
  for (const { el, label } of candidates.reverse()) {
    if (headingOptional.has(label)) {
      (el as HTMLElement).click();
      return { modalPresent: true, dismissed: true };
    }
    let scope: Element | null = el;
    for (let depth = 0; depth < 8 && scope; depth++, scope = scope.parentElement) {
      if (!heading.test(scope.textContent || '')) continue;
      (el as HTMLElement).click();
      return { modalPresent: true, dismissed: true };
    }
  }
  return { modalPresent: false, dismissed: false };
}
