// src/modules/translation/core/ports.ts
// Framework-agnostic contracts for the translation core. NO NestJS/TypeORM/engine imports.

export interface DetectResult {
  lang: string; // ISO 639-1
  confidence: number; // 0..1
}

export interface Translation {
  lang: string;
  text: string;
}

export interface ParticipantState {
  lang: string | null; // null = not learned yet
  source: 'learned' | 'pinned';
  enabled: boolean;
  samples: number;
  /** Candidate language awaiting a 2nd consecutive detection before a learned switch. */
  pendingLang?: string;
  updatedAt: string;
}

export type ParticipantMap = Record<string, ParticipantState>; // key = author WID

export interface GroupState {
  sessionId: string;
  chatId: string;
  active: boolean;
  participants: ParticipantMap;
  delegatedControllers: string[];
  announced: boolean;
}

export interface InboundMessage {
  id: string;
  chatId: string;
  body: string;
  author: string; // sender WID (group participant)
  isGroup: boolean;
  fromMe: boolean;
  mentionedIds: string[];
  pushName?: string;
}

export type CommandName =
  | 'help'
  | 'status'
  | 'on'
  | 'off'
  | 'setlang'
  | 'auto'
  | 'ignore'
  | 'unignore'
  | 'grant'
  | 'revoke';

export type CommandTarget = { kind: 'me' } | { kind: 'mention' } | { kind: 'number'; number: string };

export interface ParsedCommand {
  name: CommandName;
  lang?: string; // setlang only
  target?: CommandTarget; // setlang/auto/ignore/unignore/grant/revoke
}

export interface Translator {
  detect(text: string): Promise<DetectResult>;
  translate(text: string, source: string, target: string): Promise<string>;
  languages(): Promise<string[]>;
  isHealthy(): boolean;
}

export interface ConfigStore {
  load(sessionId: string, chatId: string): Promise<GroupState>;
  save(state: GroupState): Promise<void>;
}

export interface ChatGateway {
  sendText(sessionId: string, chatId: string, text: string): Promise<void>;
  sendCombinedReply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<void>;
  getGroupAdmins(sessionId: string, chatId: string): Promise<string[]>;
}
