import { type Client } from 'whatsapp-web.js';
import { type EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';

/** The modal's confirm-button label on an English WhatsApp Web. */
export const ONBOARDING_DEFAULT_CONTINUE_LABEL = 'Continue';

/**
 * Extra confirm-button labels for a deployment whose WhatsApp Web does not render this modal in
 * English, comma-separated (`WWEBJS_ONBOARDING_CONTINUE_LABELS=Continuar,Weiter`).
 *
 * Needed because the match is on visible text and WhatsApp controls those strings; we are not going
 * to carry its translation table. The value comes from the environment loaded at boot, so a label
 * added later takes effect only after OpenWA itself restarts; stopping and starting a session is not
 * enough.
 *
 * Supplying labels also drops the heading requirement for THOSE labels: the English heading regex
 * would reject a localised modal anyway, so requiring both would make the setting useless. That is a
 * deliberate, operator-opted-in loosening, bounded by requiring the button to sit inside a visible
 * dialog; see {@link probeOnboardingModal}.
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
 * language WhatsApp Web decides. The launch args pin `--lang=en-US`, which settles the browser's
 * locale but not necessarily WhatsApp Web's: a deployment on a Portuguese account still reported the
 * modal in Portuguese (#1679). Another language is covered by an operator-supplied label (see
 * {@link resolveOnboardingContinueLabels}), which matches WITHOUT the heading check: the English
 * heading would reject a localised modal regardless, so requiring both would make the setting inert.
 * It does require a `[role="dialog"]` or `[aria-modal="true"]` ancestor, so the word is only clicked
 * where a modal can be.
 * The default `Continue` keeps the heading requirement, so the out-of-the-box false-positive surface
 * is unchanged.
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
  // An operator label carries no heading check, so it has to sit inside a dialog at least: matched
  // page-wide, the same word on any other button would be clicked, and every click counts toward the
  // limit that takes a ready session to action_required. Same bounded walk and dialog markers as
  // collectDialogDiagnostics, which is where operators read the label from.
  const insideDialog = (el: Element): boolean => {
    let scope: Element | null = el.parentElement;
    for (let depth = 0; depth < 12 && scope; depth++, scope = scope.parentElement) {
      if (scope.getAttribute('role') === 'dialog' || scope.getAttribute('aria-modal') === 'true') return true;
    }
    return false;
  };
  for (const { el, label } of candidates.reverse()) {
    if (headingOptional.has(label)) {
      if (!insideDialog(el)) continue;
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

// Onboarding-modal watcher constants (#982). A freshly-linked account shows a "What's new on WhatsApp
// Web" modal with a Continue button that must be acknowledged, or WhatsApp unlinks the companion ~5m
// later (surfacing as disconnected: LOGOUT). whatsapp-web.js exposes no API for this (#3550 open),
// so the watcher reaches the page directly and clicks it best-effort. The modal is one-shot per
// account, so the watcher self-terminates after the lifetime cap rather than polling forever.
const ONBOARDING_MODAL_INTERVAL_MS = 5_000;
const ONBOARDING_MODAL_MAX_LIFETIME_MS = 5 * 60_000;
const ONBOARDING_MODAL_PROBE_TIMEOUT_MS = 5_000;
// Clicking Continue dismisses the modal, so one click is the normal case and the next tick finds
// nothing. Repeated clicks mean the click is not landing — the only evidence that actually justifies
// asking a human to intervene. Five, not three: a multi-step "What's new" flow is clicked through
// one screen per tick, and three screens inside one watcher run must not read as a stuck modal.
// Five failed clicks still trips in ~25s — far inside the lifetime cap and the ~5m unlink deadline.
const ONBOARDING_MODAL_MAX_DISMISS_CLICKS = 5;

/**
 * Host surface for the onboarding-modal watcher below. The adapter builds ONE object literal of
 * these closures, so the watcher never touches lifecycle state directly.
 */
export interface WwebjsOnboardingWatcherHost {
  readonly logger: ReturnType<typeof createLogger>;
  readonly config: WhatsAppWebJsConfig;
  getClient(): Client | null;
  getStatus(): EngineStatus;
  setStatus(status: EngineStatus): void;
  isTearingDown(): boolean;
  isDisconnectReported(): boolean;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
}

/**
 * The onboarding-modal watcher loop (#982), extracted from WhatsAppWebJsAdapter: a self-rescheduling
 * tick that probes the page with {@link probeOnboardingModal} and clicks through the modal, with the
 * ACTION_REQUIRED fallback for a modal the clicks cannot dismiss. The in-page probe and the label
 * resolution above stay free functions; this class owns the loop's timers and counters.
 */
export class WwebjsOnboardingWatcher {
  // Self-rescheduling setTimeout so a hung probe can't stall the loop; cleared on teardown exactly
  // like the reconcile timer.
  private onboardingWatcherTimer: ReturnType<typeof setTimeout> | null = null;
  private onboardingWatcherStartedAt = 0;
  private onboardingWatcherStarted = false;
  // How many times we have clicked the modal's Continue button. Not reset by clear(): it counts for
  // the engine's lifetime, which is what makes "the click is not landing" detectable.
  private onboardingDismissClicks = 0;
  // Dialog signatures the watcher already warned about (#1072 follow-up). A signature is the
  // serialized diagnostics of what is on screen, so the warn fires once per DISTINCT unrecognised
  // dialog instead of once per 5s tick. Dies with the engine, exactly like the watcher itself.
  private onboardingDialogSignatures = new Set<string>();
  // Probe ticks run, for the lifetime-cap summary line.
  private onboardingProbes = 0;

  constructor(private readonly host: WwebjsOnboardingWatcherHost) {}

  /**
   * Dismiss a freshly-linked account's "What's new on WhatsApp Web" onboarding modal (#982). The modal
   * has a Continue button that must be acknowledged or WhatsApp unlinks the companion ~5m later
   * (surfacing as disconnected: LOGOUT). whatsapp-web.js exposes no API for this (#3550 open), so the
   * watcher reaches the page directly. Idempotent and one-shot per engine: the modal appears once per
   * account, so the loop self-terminates at the lifetime cap instead of polling forever.
   *
   * The watcher only ever moves the session out of READY when it has clicked Continue repeatedly and
   * the modal is still there — real evidence a human must acknowledge it. A probe that cannot reach
   * the page, or a page with no such modal, leaves the session exactly where it was: blocking sends
   * over a best-effort DOM guess would be a worse outcome than the problem being guarded against.
   */
  startOnboardingWatcher(): void {
    if (this.onboardingWatcherStarted) return; // idempotent: ready event + reconcile path share one funnel
    this.onboardingWatcherStarted = true;
    this.onboardingWatcherStartedAt = Date.now();
    this.host.logger.debug('Onboarding modal watcher armed', {
      sessionId: this.host.config.sessionId,
      action: 'onboarding_watcher_started',
    });

    const tick = (): void => {
      if (
        !this.host.getClient() ||
        this.host.getStatus() !== EngineStatus.READY ||
        this.host.isTearingDown() ||
        this.host.isDisconnectReported()
      ) {
        this.clearOnboardingWatcher();
        return;
      }
      // The modal is one-shot per account: stop after the lifetime cap rather than polling forever.
      if (Date.now() - this.onboardingWatcherStartedAt >= ONBOARDING_MODAL_MAX_LIFETIME_MS) {
        // Natural end of the episode: one summary, so a log read can tell the watcher ran and what
        // it saw without per-tick noise. Teardown/disconnect stops log nothing — that is shutdown,
        // not signal.
        this.host.logger.debug('Onboarding modal watcher stopped at its lifetime cap', {
          sessionId: this.host.config.sessionId,
          probes: this.onboardingProbes,
          clicks: this.onboardingDismissClicks,
          dialogsSeen: this.onboardingDialogSignatures.size,
          action: 'onboarding_watcher_stopped',
        });
        this.clearOnboardingWatcher();
        return;
      }
      // Schedule the next tick up front so a hung page.evaluate can't stall the loop.
      this.onboardingWatcherTimer = setTimeout(tick, ONBOARDING_MODAL_INTERVAL_MS);
      this.onboardingWatcherTimer.unref?.();
      // Fire-and-forget: a rejection is the fallback signal, not a crash.
      void this.dismissOnboardingModalIfNeeded();
    };

    this.onboardingWatcherTimer = setTimeout(tick, ONBOARDING_MODAL_INTERVAL_MS);
    this.onboardingWatcherTimer.unref?.();
  }

  clearOnboardingWatcher(): void {
    if (this.onboardingWatcherTimer) {
      clearTimeout(this.onboardingWatcherTimer);
      this.onboardingWatcherTimer = null;
    }
    this.onboardingWatcherStartedAt = 0;
  }

  /**
   * One watcher tick: click the onboarding modal's Continue button if it is on screen. Returns the
   * probe verdict rather than mutating state so the loop stays the single owner of the
   * ACTION_REQUIRED transition. A rejected evaluate is NOT an operator signal — see the catch.
   */
  private async dismissOnboardingModalIfNeeded(): Promise<void> {
    const client = this.host.getClient();
    if (!client) return;
    this.onboardingProbes += 1;
    const page = (
      client as unknown as {
        pupPage?: { evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T> };
      }
    ).pupPage;

    // Resolved out here, not inside the probe: the function body is stringified into the page, so it
    // cannot read process.env. Operator-supplied labels skip the English heading check (see the probe).
    const labels = resolveOnboardingContinueLabels();
    const headingOptionalFor = labels.filter(label => label !== ONBOARDING_DEFAULT_CONTINUE_LABEL);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        page?.evaluate(probeOnboardingModal, { labels, headingOptionalFor }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('onboarding modal probe timed out')),
            ONBOARDING_MODAL_PROBE_TIMEOUT_MS,
          );
          timeout.unref?.();
        }),
      ]);

      // The probe found nothing to click: ask the page what dialogs ARE on screen, so a modal whose
      // title or button label the detector does not recognise is visible in the logs instead of
      // failing silently until WhatsApp unlinks the companion (#1072 follow-up). The `=== false`
      // dispatch is deliberate: a probe that clicked (dismissed) needs no diagnostics, and an
      // absent/garbled result says the page is in no state to answer a second evaluate either.
      if (result && result.dismissed === false) {
        const dialogs = await page?.evaluate(collectDialogDiagnostics);
        if (Array.isArray(dialogs) && dialogs.length > 0) {
          const signature = JSON.stringify(dialogs);
          if (!this.onboardingDialogSignatures.has(signature)) {
            this.onboardingDialogSignatures.add(signature);
            this.host.logger.warn(
              'A visible dialog on WhatsApp Web matches neither the onboarding-modal heading nor a ' +
                'confirm-button label. If this is the onboarding screen in another language, add its ' +
                'confirm-button label to WWEBJS_ONBOARDING_CONTINUE_LABELS and restart OpenWA; on a ' +
                'newly linked account WhatsApp unlinks the companion within minutes while it stays open. ' +
                'An English onboarding screen that is not recognised is worth reporting.',
              {
                sessionId: this.host.config.sessionId,
                dialogs,
                action: 'onboarding_dialog_unrecognized',
              },
            );
          }
        }
      }

      if (!result?.dismissed) return;

      // We clicked. A modal that is really dismissed is gone by the next tick, so a click here is
      // normally a one-off. Repeated clicks mean the click is not taking effect (an overlay is
      // swallowing it, or WhatsApp keeps re-showing the modal) — that, and only that, is evidence a
      // human has to acknowledge it on the phone before the companion is unlinked.
      this.onboardingDismissClicks += 1;
      this.host.logger.log('Dismissed the WhatsApp Web onboarding modal', {
        sessionId: this.host.config.sessionId,
        attempt: this.onboardingDismissClicks,
        action: 'onboarding_modal_dismissed',
      });
      if (this.onboardingDismissClicks >= ONBOARDING_MODAL_MAX_DISMISS_CLICKS) {
        this.reportActionRequired(
          `WhatsApp is still showing its onboarding modal after ${this.onboardingDismissClicks} ` +
            "attempts to dismiss it. Open WhatsApp Web on the account holder's own browser and click " +
            'through the "What\'s new" screen, or the companion device will be unlinked. Then restart ' +
            'the session (stop, then start) — acknowledging the modal does not return it to ready on its own.',
        );
      }
    } catch {
      // The page navigated, closed, or the probe timed out. This is expected around a reload or a
      // teardown and says nothing about the modal, so it must not move the session: a status change
      // here would take a HEALTHY session out of READY, which blocks every send (ensureReady) for a
      // reason the operator cannot act on. A page that is genuinely gone surfaces through the
      // puppeteer lifecycle listeners as a disconnect, which is where that belongs.
      this.host.logger.debug('Onboarding modal probe could not reach the page; ignoring', {
        sessionId: this.host.config.sessionId,
        action: 'onboarding_modal_probe_skipped',
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  reportActionRequired(reason: string): void {
    this.clearOnboardingWatcher();
    if (this.host.getStatus() !== EngineStatus.READY) {
      // A teardown/failure latched first: its status stands and the callback stays silent — but the
      // reason must not vanish without a trace, or this path is indistinguishable from "no modal".
      this.host.logger.debug('Onboarding modal fallback superseded by a status change; not moving to ACTION_REQUIRED', {
        sessionId: this.host.config.sessionId,
        status: this.host.getStatus(),
        action: 'onboarding_action_required_suppressed',
      });
      return;
    }
    this.host.setStatus(EngineStatus.ACTION_REQUIRED);
    this.host.getCallbacks().onActionRequired?.(reason);
    this.host.logger.warn(reason, { sessionId: this.host.config.sessionId, action: 'onboarding_modal_fallback' });
  }
}
