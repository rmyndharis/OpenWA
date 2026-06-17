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

    const targets = this.targetLanguages(state, detected);
    if (targets.length === 0) {
      await this.store.save(state);
      return;
    }

    const settled = await Promise.allSettled(targets.map(t => this.translator.translate(text, detected, t)));
    const translations: Translation[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') translations.push({ lang: targets[i], text: r.value });
    });

    if (translations.length > 0) {
      await this.gateway.sendCombinedReply(sessionId, msg.chatId, msg.id, formatCombinedReply(translations));
    }
    await this.store.save(state);
  }

  /** Distinct languages of enabled participants, minus the detected source language. */
  private targetLanguages(state: GroupState, source: string): string[] {
    const langs = new Set<string>();
    for (const p of Object.values(state.participants)) {
      if (p.enabled && p.lang && p.lang !== source) langs.add(p.lang);
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
      const isAdmin = admins.includes(msg.author);
      const isController = isAdmin || state.delegatedControllers.includes(msg.author);
      const adminOnly = cmd.name === 'grant' || cmd.name === 'revoke';
      if ((adminOnly && !isAdmin) || (!adminOnly && !isController)) {
        if (this.opts.denyReply) {
          await this.gateway.sendText(sessionId, msg.chatId, '⛔ Only group admins can do that.');
        }
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
        if (!targetWid) return;
        const p = this.ensureParticipant(state, targetWid);
        p.source = 'learned';
        p.pendingLang = undefined;
        await this.confirm(sessionId, msg, `✅ ${targetWid} set to auto-detect.`, state);
        return;
      }
      case 'ignore':
      case 'unignore': {
        if (!targetWid) return;
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
        if (!targetWid) return;
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
}
