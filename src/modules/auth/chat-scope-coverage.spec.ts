// Structural guard for the chat-scope class of bug: a key restricted with `allowedChats` must not
// reach a chat outside its fence.
//
// The guard is DEFAULT DENY (api-key.guard.ts): a chat-restricted key is refused with 403 on every
// handler that is not marked @ChatScoped, so surfaces with no chat dimension (webhooks, automation
// rules, status, key management, channels, Bull Board) and every route added later stay closed
// without being enumerated.
//
// Marking carries the reason, and this spec checks each one:
//
//   @ChatScoped('fenced')    the handler names a chat the guard inspects — a `:chatId` / `:groupId` /
//                            `:contactId` path param, or a REQUIRED guard-read body field
//                            (`chatId` / `fromChatId` / `toChatId` / `messages[]`). An optional
//                            `?chatId=` qualifies only when the handler also calls
//                            `this.chatScope.requireChat(`, which refuses a restricted key that omits
//                            it; on its own the guard would have nothing to check.
//   @ChatScoped('filtered')  the handler lists chats and returns through ChatScopeService.filter.
//   @ChatScoped('agnostic')  the handler cannot reach a chat at all. This is the one category the
//                            spec cannot derive (a webhook with `events: ['*']` also names no chat),
//                            so every grant must also appear in AGNOSTIC_GRANTS.
//
// Every @ChatScoped decorator must pair with a parsed handler (the non-vacuity check below), so a
// decorator the parser cannot see fails rather than silently going unchecked.
import { readdirSync, readFileSync } from 'fs';
import { basename, join, sep } from 'path';

/** Route params the ApiKeyGuard treats as a chat id. Asserted against the guard's own source below. */
export const GUARD_CHAT_ROUTE_PARAMS = ['chatId', 'groupId', 'contactId'];
/** Body fields the ApiKeyGuard treats as a chat id (bulk send nests `chatId` inside `messages[]`). */
export const GUARD_BODY_CHAT_FIELDS = ['chatId', 'fromChatId', 'toChatId'];

/**
 * The complete set of handlers granted `@ChatScoped('agnostic')`. Each entry is a deliberate access
 * decision, so the spec fails if a grant is missing from here OR listed here without the mark.
 * Key format: `<controller file basename> :: <handler name>`.
 */
export const AGNOSTIC_GRANTS: ReadonlyArray<readonly [string, string]> = [
  // Reports the session's own state and account: no chat data, changes nothing, and an integration
  // needs it to know whether its session is connected.
  ['session.controller.ts', 'findOne'],
];

/**
 * The complete set of handlers granted `@ChatQuotedAllowed()`: routes whose `quotedMessageId` is
 * bound to the chat they send into, so a quote cannot name a chat outside the allowlist. Every entry
 * is a deliberate decision; the spec fails if a grant is unused or unlisted.
 */
export const QUOTED_ALLOWED_GRANTS: ReadonlyArray<readonly [string, string]> = [
  // Reply requires a quotedMessageId and both engines resolve it inside the named chat.
  ['message.controller.ts', 'reply'],
];

/**
 * Handlers that must stay UNMARKED, so default-deny keeps refusing them. The group routes would pass
 * the category checks if marked 'fenced' (`:groupId` counts as a chat param), which is why they are
 * pinned; the batch routes are pinned so that marking them stays a deliberate decision.
 */
export const MUST_STAY_UNMARKED: ReadonlyArray<readonly [string, string]> = [
  // Adding a participant can DM them an invite (whatsapp-web.js autoSendInviteV4), a chat the
  // guard never sees; the other three change who belongs to a group outside the key's own chats.
  ['group.controller.ts', 'addParticipants'],
  ['group.controller.ts', 'removeParticipants'],
  ['group.controller.ts', 'promoteParticipants'],
  ['group.controller.ts', 'demoteParticipants'],
  // A join request comes from a number outside the key's chats: listing the queue names them, and
  // approving or rejecting decides whether they join, the same membership change refused above.
  ['group.controller.ts', 'getMembershipRequests'],
  ['group.controller.ts', 'approveMembershipRequests'],
  ['group.controller.ts', 'rejectMembershipRequests'],
  // An invite link admits anyone who holds it, no request to decide, and keeps working after the key
  // is revoked; revoking returns a fresh link, so both routes hand the key the same capability.
  ['group.controller.ts', 'getInviteCode'],
  ['group.controller.ts', 'revokeInviteCode'],
  // A batch row has no key owner, so its status and cancel cannot be checked against an allowlist.
  ['message.controller.ts', 'getBatchStatus'],
  ['message.controller.ts', 'cancelBatch'],
];

/** Handlers that must stay marked with the given category; a lost mark silently becomes a 403. */
export const MUST_STAY_MARKED: ReadonlyArray<readonly [string, string, string]> = [
  // Live history, whatsapp-web.js only.
  ['message.controller.ts', 'getChatHistory', 'fenced'],
  // Stored history on both engines, for the chat named in ?chatId=.
  ['message.controller.ts', 'getMessages', 'fenced'],
  // List routes a restricted key may use, each filtered to its chats before paging.
  ['session.controller.ts', 'getChats', 'filtered'],
  ['session.controller.ts', 'getGroups', 'filtered'],
  ['contact.controller.ts', 'findAll', 'filtered'],
  ['label.controller.ts', 'getChatsByLabel', 'filtered'],
];

const REQUIRED_GUARD_FIELD = new RegExp(`\\b(?:${GUARD_BODY_CHAT_FIELDS.join('|')})!\\s*:`);
const REQUIRED_BULK_FIELD = /\bmessages!\s*:/;

/** Request DTO classes carrying a REQUIRED guard-read chat field. */
function requiredGuardChatDtos(dir: string): Set<string> {
  const own = new Set<string>();
  const parents = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
      for (const chunk of readFileSync(full, 'utf8')
        .split(/export\s+class\s+/)
        .slice(1)) {
        const name = /^([A-Za-z0-9_]+)/.exec(chunk)?.[1];
        if (!name) continue;
        const parent = /^[A-Za-z0-9_]+\s+extends\s+([A-Za-z0-9_]+)/.exec(chunk)?.[1];
        if (parent) parents.set(name, parent);
        if (REQUIRED_GUARD_FIELD.test(chunk) || REQUIRED_BULK_FIELD.test(chunk)) own.add(name);
      }
    }
  };
  walk(dir);
  // Resolve `extends` transitively: a DTO inheriting a fenced `chatId` counts (send-audio extends the
  // media DTO). Anything unresolved or cyclic is simply not required.
  const out = new Set<string>();
  for (const name of [...own, ...parents.keys()]) {
    let cursor: string | undefined = name;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (own.has(cursor)) {
        out.add(name);
        break;
      }
      cursor = parents.get(cursor);
    }
  }
  return out;
}

/** Every handler carrying `@ChatQuotedAllowed()` in `source`. */
export function quotedAllowedHandlers(source: string): string[] {
  const out: string[] = [];
  const handlerRe = /((?:^ {2}@[\s\S]*?)?)^ {2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(/gm;
  for (let m = handlerRe.exec(source); m !== null; m = handlerRe.exec(source)) {
    if (/@ChatQuotedAllowed\(\)/.test(m[1] ?? '')) out.push(m[2]);
  }
  return out;
}

/** Every @ChatScoped decorator in `source` paired with the handler it decorates. */
export function chatScopedHandlers(source: string): Array<{ name: string; kind: string; body: string }> {
  const out: Array<{ name: string; kind: string; body: string }> = [];
  const handlerRe = /((?:^ {2}@[\s\S]*?)?)^ {2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*[:{]/gm;
  const matches: { name: string; from: number; decorators: string }[] = [];
  for (let m = handlerRe.exec(source); m !== null; m = handlerRe.exec(source)) {
    matches.push({ name: m[2], from: m.index, decorators: m[1] ?? '' });
  }
  for (let i = 0; i < matches.length; i++) {
    const kind = /@ChatScoped\(\s*'([a-z]+)'\s*\)/.exec(matches[i].decorators)?.[1];
    if (kind === undefined) continue;
    out.push({
      name: matches[i].name,
      kind,
      body: source.slice(matches[i].from, matches[i + 1]?.from ?? source.length),
    });
  }
  return out;
}

/** Return a description of every marked handler that does not hold up its declared category. */
export function chatScopeViolations(
  source: string,
  file: string,
  requiredDtos: Set<string>,
  agnosticGrants: ReadonlyArray<readonly [string, string]> = AGNOSTIC_GRANTS,
): string[] {
  const offenders: string[] = [];
  for (const { name, kind, body } of chatScopedHandlers(source)) {
    const hasPathChat = new RegExp(`@Param\\(\\s*['"](?:${GUARD_CHAT_ROUTE_PARAMS.join('|')})['"]\\s*\\)`).test(body);
    const bodyDto = /@Body\(\)\s*[A-Za-z0-9_]+\s*:\s*([A-Za-z0-9_]+)/.exec(body)?.[1];
    const hasRequiredBodyChat = bodyDto !== undefined && requiredDtos.has(bodyDto);
    const hasRequiredQueryChat =
      /@Query\(\s*['"]chatId['"]\s*\)/.test(body) && /this\.chatScope\.requireChat\(/.test(body);
    if (kind === 'fenced' && !(hasPathChat || hasRequiredBodyChat || hasRequiredQueryChat))
      offenders.push(`${name} (fenced, no guard-read chat)`);
    else if (kind === 'filtered' && !/chatScope\.filter\(/.test(body)) offenders.push(`${name} (filtered, no filter)`);
    else if (kind === 'agnostic' && !agnosticGrants.some(([f, h]) => f === file && h === name))
      offenders.push(`${name} (agnostic, not on AGNOSTIC_GRANTS)`);
    else if (!['fenced', 'filtered', 'agnostic'].includes(kind)) offenders.push(`${name} (unknown kind '${kind}')`);
  }
  return offenders;
}

function listControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('a chat-restricted key can only reach a handler fenced to its allowedChats', () => {
  it('the guard denies by default and fences every chat id it can see', () => {
    const guard = readFileSync(join(__dirname, 'guards', 'api-key.guard.ts'), 'utf8');
    expect(guard).toContain('CHAT_SCOPED_KEY');
    expect(guard).toContain('API key is restricted to selected chats');
    for (const param of GUARD_CHAT_ROUTE_PARAMS) expect(guard).toContain(`'${param}'`);
    for (const field of GUARD_BODY_CHAT_FIELDS) expect(guard).toContain(`'${field}'`);
    expect(guard).toContain("['chatId']");
    expect(guard).toContain('messages');
    // A chat reference the guard cannot fence is refused outright.
    expect(guard).toContain('quotedMessageId');
  });

  it("flags a 'fenced' handler that names no guard-read chat", () => {
    const source = `
  @ChatScoped('fenced')
  @Post('status')
  async postStatus(@Body() dto: StatusDto): Promise<unknown> {
    return this.svc.post(dto);
  }
`;
    expect(chatScopeViolations(source, 'x.controller.ts', new Set())).toEqual([
      'postStatus (fenced, no guard-read chat)',
    ]);
  });

  it("flags a 'fenced' handler whose only chat is an optional query param", () => {
    const source = `
  @ChatScoped('fenced')
  @Get()
  async list(@Query('chatId') chatId?: string): Promise<unknown> {
    return this.svc.list(chatId);
  }
`;
    expect(chatScopeViolations(source, 'x.controller.ts', new Set())).toEqual(['list (fenced, no guard-read chat)']);
  });

  it("clears a 'fenced' optional query chat only when the handler requires it", () => {
    const required = `
  @ChatScoped('fenced')
  @Get()
  async list(@Query('chatId') chatId?: string, @CurrentApiKey() apiKey?: ApiKey): Promise<unknown> {
    this.chatScope.requireChat(apiKey, chatId);
    return this.svc.list(chatId);
  }
`;
    expect(chatScopeViolations(required, 'x.controller.ts', new Set())).toEqual([]);

    const noQuery = `
  @ChatScoped('fenced')
  @Get()
  async list(@CurrentApiKey() apiKey?: ApiKey): Promise<unknown> {
    this.chatScope.requireChat(apiKey, undefined);
    return this.svc.list();
  }
`;
    expect(chatScopeViolations(noQuery, 'x.controller.ts', new Set())).toEqual(['list (fenced, no guard-read chat)']);
  });

  it("flags a 'filtered' handler that does not filter and an unlisted 'agnostic'", () => {
    const source = `
  @ChatScoped('filtered')
  @Get('chats')
  async chats(): Promise<unknown> {
    return this.svc.chats();
  }

  @ChatScoped('agnostic')
  @Get('profile')
  async profile(): Promise<unknown> {
    return this.svc.profile();
  }
`;
    expect(chatScopeViolations(source, 'x.controller.ts', new Set())).toEqual([
      'chats (filtered, no filter)',
      'profile (agnostic, not on AGNOSTIC_GRANTS)',
    ]);
  });

  it('clears a fenced path chat, a required body chat, a filter, and a listed agnostic grant', () => {
    const source = `
  @ChatScoped('fenced')
  @Get(':chatId')
  async getOne(@Param('chatId') chatId: string): Promise<unknown> {
    return this.svc.get(chatId);
  }

  @ChatScoped('fenced')
  @Post()
  async send(@Body() dto: SendThingDto): Promise<unknown> {
    return this.svc.send(dto);
  }

  @ChatScoped('filtered')
  @Get('chats')
  async chats(@CurrentApiKey() apiKey: ApiKey): Promise<unknown> {
    return this.chatScope.filter(apiKey, await this.svc.chats(), c => c.id);
  }

  @ChatScoped('agnostic')
  @Get('granted')
  async granted(): Promise<unknown> {
    return this.svc.granted();
  }
`;
    expect(
      chatScopeViolations(source, 'x.controller.ts', new Set(['SendThingDto']), [['x.controller.ts', 'granted']]),
    ).toEqual([]);
  });

  it('keeps the pinned handlers unmarked, and the pinned marks in place', () => {
    const sources = new Map(
      listControllerFiles(join(__dirname, '..')).map(f => [basename(f), readFileSync(f, 'utf8')]),
    );
    const marks = (file: string): Map<string, string> => {
      const source = sources.get(file);
      if (source === undefined) throw new Error(`${file} not found`);
      return new Map(chatScopedHandlers(source).map(({ name, kind }) => [name, kind]));
    };
    for (const [file, name] of [...MUST_STAY_UNMARKED, ...MUST_STAY_MARKED]) {
      // A renamed handler must fail here rather than leave the pin checking nothing.
      expect({
        file,
        name,
        found: new RegExp(`^ {2}(?:async\\s+)?${name}\\s*\\(`, 'm').test(sources.get(file) ?? ''),
      }).toEqual({
        file,
        name,
        found: true,
      });
    }
    for (const [file, name] of MUST_STAY_UNMARKED)
      expect({ file, name, kind: marks(file).get(name) }).toEqual({ file, name, kind: undefined });
    for (const [file, name, kind] of MUST_STAY_MARKED)
      expect({ file, name, kind: marks(file).get(name) }).toEqual({ file, name, kind });
  });

  it('pairs every decorator with a parsed handler, and the scan is not vacuous', () => {
    const modulesDir = join(__dirname, '..');
    const requiredDtos = requiredGuardChatDtos(modulesDir);
    expect(requiredDtos.size).toBeGreaterThan(0); // the DTO scan must not silently collapse
    const files = listControllerFiles(modulesDir);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    const seenGrants = new Set<string>();
    const seenQuoted = new Set<string>();
    let marked = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const fileName = basename(file);
      const posixPath = file
        .split(sep)
        .join('/')
        .replace(/.*\/src\//, 'src/');
      // Non-vacuity: every @ChatScoped decorator in the file must pair with a parsed handler, or the
      // parser is blind to it and the category checks never run.
      const decorators = [...source.matchAll(/@ChatScoped\(/g)].length;
      const paired = chatScopedHandlers(source);
      expect({ file: posixPath, decorators, paired: paired.length }).toEqual({
        file: posixPath,
        decorators: paired.length,
        paired: paired.length,
      });
      marked += paired.length;
      for (const { name, kind } of paired) if (kind === 'agnostic') seenGrants.add(`${fileName} :: ${name}`);
      for (const name of quotedAllowedHandlers(source)) seenQuoted.add(`${fileName} :: ${name}`);
      for (const violation of chatScopeViolations(source, fileName, requiredDtos)) {
        offenders.push(`${posixPath} :: ${fileName} :: ${violation}`);
      }
    }
    expect(marked).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
    // Every declared grant is used, and every used grant is declared.
    expect([...seenGrants].sort()).toEqual(AGNOSTIC_GRANTS.map(([f, h]) => `${f} :: ${h}`).sort());
    expect([...seenQuoted].sort()).toEqual(QUOTED_ALLOWED_GRANTS.map(([f, h]) => `${f} :: ${h}`).sort());
  });
});
