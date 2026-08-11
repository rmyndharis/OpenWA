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

/**
 * In-page diagnostics for the onboarding watcher (#1072 follow-up): when {@link probeOnboardingModal}
 * finds nothing to click, report what dialogs ARE on screen, so a modal the detector does not
 * recognise — a title WhatsApp changed, another language — shows up in the logs instead of failing
 * silently until the companion is unlinked. Observational only: it clicks nothing and changes
 * nothing, and the adapter logs the result once per distinct answer.
 *
 * Scoped to dialog containers on purpose. The heading text of a `[role="dialog"]` is UI chrome; a
 * chat-list row is not a dialog, so ordinary conversation content never enters the report. The
 * probe's own comment documents why treating page text as a MATCH signal is dangerous — nothing
 * here is a match signal, but the capture is still bounded (three dialogs, five buttons each,
 * truncated strings) so a pathological page cannot flood the logs.
 *
 * Every captured string is sanitized: the text goes straight into a log line, and a newline or
 * control character in page-controlled text would forge extra log entries.
 *
 * Self-contained like the probe: `page.evaluate` stringifies this into the browser, so nothing may
 * be closed over — every constant lives in the body — and being a plain function keeps the DOM work
 * unit-testable.
 */
export function collectDialogDiagnostics(): Array<{ heading: string | null; buttons: string[] }> {
  const MAX_DIALOGS = 3;
  const MAX_BUTTONS_PER_DIALOG = 5;
  const ASSOCIATION_WALK = 12;
  const HEADING_TEXT_MAX = 80;
  const BUTTON_LABEL_MAX = 40;

  const clean = (text: string, max: number): string =>
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const isVisible = (el: Element): boolean => {
    const rect = (el as HTMLElement).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (el as HTMLElement).offsetParent !== null;
  };
  // Association walks UP from the candidate, bounded, so a heading or button anywhere on the page
  // is never attributed to a dialog it merely shares a distant ancestor with.
  const within = (el: Element, ancestor: Element): boolean => {
    let scope: Element | null = el.parentElement;
    for (let depth = 0; depth < ASSOCIATION_WALK && scope; depth++, scope = scope.parentElement) {
      if (scope === ancestor) return true;
    }
    return false;
  };

  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
    .filter(isVisible)
    .slice(0, MAX_DIALOGS);
  if (dialogs.length === 0) return [];
  const headings = Array.from(document.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6')).filter(isVisible);
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);

  return dialogs.map(dialog => {
    const headingEl = headings.find(h => within(h, dialog));
    const rawHeading = headingEl ? headingEl.textContent : dialog.getAttribute('aria-label');
    const heading = rawHeading ? clean(String(rawHeading), HEADING_TEXT_MAX) : '';
    const labels = buttons
      .filter(b => within(b, dialog))
      .map(b => clean(b.textContent || '', BUTTON_LABEL_MAX))
      .filter(label => label.length > 0)
      .slice(0, MAX_BUTTONS_PER_DIALOG);
    return { heading: heading || null, buttons: labels };
  });
}
