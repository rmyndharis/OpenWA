// src/modules/translation/core/translation.coordinator.ts
import {
  ChatGateway,
  ConfigStore,
  GroupState,
  InboundMessage,
  ParsedCommand,
  ParticipantState,
  Translation,
  Translator,
  CommandTarget,
} from './ports';
import { parseCommand } from './command.parser';
import { buildHelpText, formatCombinedReply, formatStatus } from './reply.formatter';

export interface CoordinatorOptions {
  prefix: string;
  minLength: number;
  maxLength: number;
  denyReply: boolean;
}

const URL_OR_EMOJI_ONLY = /^(?:\s|\p{Emoji}|https?:\/\/\S+)+$/u;

/**
 * Compare two WhatsApp IDs tolerantly: exact match, or same user part ignoring
 * an `@domain` and any `:device` suffix (e.g. `123@c.us` === `123:7@c.us`).
 * Note: this does NOT bridge the LID (`@lid`) and phone (`@c.us`) namespaces —
 * those have different user numbers (see spec §16).
 */
function widEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const userPart = (w: string): string => w.split('@')[0].split(':')[0];
  return userPart(a) === userPart(b);
}

export class TranslationCoordinator {
  constructor(
    private readonly translator: Translator,
    private readonly store: ConfigStore,
    private readonly gateway: ChatGateway,
    private readonly opts: CoordinatorOptions,
  ) {}

  async handleMessage(sessionId: string, msg: InboundMessage): Promise<{ swallow: boolean }> {
    if (!msg.isGroup || msg.fromMe || !msg.author) return { swallow: false };

    const state = await this.store.load(sessionId, msg.chatId);

    if (!state.announced) {
      await this.gateway.sendText(sessionId, msg.chatId, buildHelpText(this.opts.prefix));
      state.announced = true;
      await this.store.save(state);
    }

    const command = parseCommand(msg.body, this.opts.prefix);
    if (command) {
      await this.handleCommand(sessionId, msg, state, command);
      return { swallow: true };
    }

    if (!state.active) return { swallow: false };
    await this.translateMessage(sessionId, msg, state);
    return { swallow: false };
  }

  private async translateMessage(sessionId: string, msg: InboundMessage, state: GroupState): Promise<void> {
    const text = msg.body.trim();
    if (text.length < this.opts.minLength || text.length > this.opts.maxLength || URL_OR_EMOJI_ONLY.test(text)) {
      return;
    }

    const sender = this.ensureParticipant(state, msg.author);
    if (!sender.enabled) return;

    let detected: string;
    try {
      detected = (await this.translator.detect(text)).lang;
    } catch {
      return; // translator down — silent skip
    }
    this.applyLearning(sender, detected);

    // Pick the effective source language. Detection misfires on short/colloquial text — it often
    // returns a near-neighbour language (e.g. es misread as gl/ca) — so trust the detected code only
    // when it names a language the group actually uses; otherwise fall back to the sender's known
    // language. Combined with excluding the sender's own language from the targets below, this stops
    // a message ever being "translated" into its own language (the duplicate/echo bug).
    const knownLangs = this.knownLanguages(state);
    const source = knownLangs.includes(detected) ? detected : (sender.lang ?? detected);

    const targets = this.targetLanguages(state, source, sender.lang);
    if (targets.length === 0) {
      await this.store.save(state);
      return;
    }

    const settled = await Promise.allSettled(targets.map(t => this.translator.translate(text, source, t)));
    const translations: Translation[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') translations.push({ lang: targets[i], text: r.value });
    });

    if (translations.length > 0) {
      await this.gateway.sendCombinedReply(sessionId, msg.chatId, msg.id, formatCombinedReply(translations));
    }
    await this.store.save(state);
  }

  /** Distinct languages currently spoken by enabled participants. */
  private knownLanguages(state: GroupState): string[] {
    const langs = new Set<string>();
    for (const p of Object.values(state.participants)) {
      if (p.enabled && p.lang) langs.add(p.lang);
    }
    return [...langs];
  }

  /**
   * Distinct languages of enabled participants, excluding the message source language AND the
   * sender's own language — a sender never needs their own message translated back to themselves
   * (this also guards against a detection misfire leaving the source language in the target set).
   */
  private targetLanguages(state: GroupState, source: string, senderLang: string | null): string[] {
    const langs = new Set<string>();
    for (const p of Object.values(state.participants)) {
      if (p.enabled && p.lang && p.lang !== source && p.lang !== senderLang) langs.add(p.lang);
    }
    return [...langs];
  }

  /** 2-message debounce: a learned language only switches after a new language is seen twice in a row. */
  private applyLearning(p: ParticipantState, detected: string): void {
    p.samples++;
    if (p.source === 'pinned') return;
    if (p.lang === detected) {
      p.pendingLang = undefined;
      return;
    }
    if (p.pendingLang === detected) {
      p.lang = detected;
      p.pendingLang = undefined;
    } else {
      p.pendingLang = detected;
      if (p.lang === null) p.lang = detected; // cold start: adopt immediately
    }
    p.updatedAt = new Date().toISOString();
  }

  private ensureParticipant(state: GroupState, wid: string): ParticipantState {
    if (!state.participants[wid]) {
      state.participants[wid] = { lang: null, source: 'learned', enabled: true, samples: 0, updatedAt: '' };
    }
    return state.participants[wid];
  }

  private async handleCommand(
    sessionId: string,
    msg: InboundMessage,
    state: GroupState,
    cmd: ParsedCommand,
  ): Promise<void> {
    if (cmd.name === 'help') {
      await this.gateway.sendText(sessionId, msg.chatId, buildHelpText(this.opts.prefix));
      return;
    }
    if (cmd.name === 'status') {
      await this.gateway.sendText(sessionId, msg.chatId, formatStatus(state, this.translator.isHealthy()));
      return;
    }

    const targetsSelf = cmd.target?.kind === 'me';
    const isSelfServe = (cmd.name === 'setlang' || cmd.name === 'auto') && targetsSelf;
    if (!isSelfServe) {
      const admins = await this.gateway.getGroupAdmins(sessionId, msg.chatId);
      const isAdmin = admins.some(a => widEquals(a, msg.author));
      const isController = isAdmin || state.delegatedControllers.some(c => widEquals(c, msg.author));
      const adminOnly = cmd.name === 'grant' || cmd.name === 'revoke';
      if ((adminOnly && !isAdmin) || (!adminOnly && !isController)) {
        // Always reply on denial — a command must never fail silently.
        await this.gateway.sendText(
          sessionId,
          msg.chatId,
          adminOnly
            ? '⛔ Only group admins can use that command.'
            : '⛔ Only group admins or delegated users can use that command.',
        );
        return;
      }
    }

    const targetWid = this.resolveTarget(msg, cmd.target);

    switch (cmd.name) {
      case 'on':
        state.active = true;
        await this.confirm(sessionId, msg, '✅ Translation activated.', state);
        return;
      case 'off':
        state.active = false;
        await this.confirm(sessionId, msg, '✅ Translation deactivated.', state);
        return;
      case 'setlang': {
        if (!targetWid || !cmd.lang)
          return this.replyError(sessionId, msg, 'Usage: ' + this.opts.prefix + ' setlang <code> [me|@user|number]');
        const langs = await this.safeLanguages();
        if (langs && !langs.includes(cmd.lang)) {
          return this.replyError(sessionId, msg, `Unsupported language "${cmd.lang}". Supported: ${langs.join(', ')}`);
        }
        const p = this.ensureParticipant(state, targetWid);
        p.lang = cmd.lang;
        p.source = 'pinned';
        p.pendingLang = undefined;
        p.updatedAt = new Date().toISOString();
        await this.confirm(sessionId, msg, `✅ Set ${targetWid} to ${cmd.lang}.`, state);
        return;
      }
      case 'auto': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const p = this.ensureParticipant(state, targetWid);
        p.source = 'learned';
        p.pendingLang = undefined;
        await this.confirm(sessionId, msg, `✅ ${targetWid} set to auto-detect.`, state);
        return;
      }
      case 'ignore':
      case 'unignore': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const p = this.ensureParticipant(state, targetWid);
        p.enabled = cmd.name === 'unignore';
        await this.confirm(
          sessionId,
          msg,
          `✅ ${cmd.name === 'ignore' ? 'Ignoring' : 'Including'} ${targetWid}.`,
          state,
        );
        return;
      }
      case 'grant':
      case 'revoke': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const set = new Set(state.delegatedControllers);
        if (cmd.name === 'grant') set.add(targetWid);
        else set.delete(targetWid);
        state.delegatedControllers = [...set];
        await this.confirm(
          sessionId,
          msg,
          `✅ ${cmd.name === 'grant' ? 'Granted' : 'Revoked'} control for ${targetWid}.`,
          state,
        );
        return;
      }
    }
  }

  private resolveTarget(msg: InboundMessage, target?: CommandTarget): string | null {
    if (!target || target.kind === 'me') return msg.author;
    if (target.kind === 'mention') return msg.mentionedIds[0] ?? null;
    // NOTE: a `<number>` target assumes phone-number JID keying (`<number>@c.us`). Under
    // WhatsApp's newer LID scheme participants may be keyed by an opaque `@lid` id instead,
    // so this constructed wid can fail to match the stored participant. The `@mention` and
    // `me` forms resolve to the actual wid and are robust to LID; prefer them. See spec §16.
    return `${target.number}@c.us`;
  }

  private async safeLanguages(): Promise<string[] | null> {
    try {
      return await this.translator.languages();
    } catch {
      return null; // can't validate — allow
    }
  }

  private async confirm(sessionId: string, msg: InboundMessage, text: string, state: GroupState): Promise<void> {
    await this.store.save(state);
    await this.gateway.sendText(sessionId, msg.chatId, text);
  }

  private replyError(sessionId: string, msg: InboundMessage, text: string): Promise<void> {
    return this.gateway.sendText(sessionId, msg.chatId, text);
  }

  private targetHelp(): string {
    return "⚠️ Couldn't identify that user. Target them by @mention, by phone number, or use 'me' for yourself.";
  }
}
