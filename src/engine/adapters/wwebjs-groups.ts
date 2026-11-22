import { BadRequestException } from '@nestjs/common';
import { type Client } from 'whatsapp-web.js';
import {
  Group,
  GroupInfo,
  GroupJoinInfo,
  GroupMemberAddMode,
  GroupMembershipRequest,
  GroupMembershipRequestMethod,
  MediaInput,
  GroupParticipant,
  ParticipantOperationResult,
} from '../interfaces/whatsapp-engine.interface';
import { GroupChat, GroupMetadataRaw, SerializedWid, readWid } from '../types/whatsapp-web-js.types';
import { parseWaId, toParticipantWid, userPart } from '../identity/wa-id';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EnginePageReloadingError } from '../../common/errors/engine-page-reloading.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { toMessageMedia } from './wwebjs-messaging';
import {
  type WwebjsEngineHost,
  navigationsSeen,
  rethrowIfNavigation,
  throwIfNavigatedSince,
  withPageWrite,
  reportPageDeath,
} from './wwebjs-host';
import { isMissingRequireError, isNavigationError, isProtocolTimeout } from './wwebjs-lifecycle';
import { listChats, recoverGroupChatById } from './wwebjs-chats';
import { type EvaluatePage, type PageWrite, runWriteInPage, settleWriteStatus } from './wwebjs-page-writes';

/**
 * Extracts the JID of the parent community a group is linked to, if any.
 * The field name has varied across whatsapp-web.js/WA Web versions, so
 * known candidates are checked in order.
 */
export function extractLinkedParentJID(groupMetadata?: GroupMetadataRaw): string | null {
  const candidate =
    groupMetadata?.parentGroup ?? groupMetadata?.linkedParentGroup ?? groupMetadata?.linkedParent ?? null;

  if (!candidate) {
    return null;
  }

  return readWid(candidate) ?? null;
}

/**
 * GroupChat.revokeInvite, run IN-PAGE with the refusal handling its siblings already have. Upstream's
 * getInviteCode and the admin-only setters catch WA Web's `ServerStatusCodeError` (a non-admin
 * refusal) and resolve nothing; revokeInvite alone lets it reject, so a refusal reached the caller as
 * an opaque 500. Outside the page the error's name is no longer reliable (Puppeteer rebuilds it from
 * the page's constructor name), so the check has to happen here.
 *
 * The job that resets the code has moved between WhatsApp Web builds: `WAWebGroupInviteJob` exports it on the build
 * the gateway selects today and `WAWebGroupQueryJob` did before, and both take the same wid and resolve the same
 * `{code}`. From a page.evaluate Meta's `require` answers `undefined` for a module the page has not defined, and throws
 * only inside a guard or before the page's error setup has run, so each lookup tests the answer and guards the throw; a
 * document with no `require` at all is a page that is reloading, not a build without the job, and that failure is let
 * through. A build with neither, or without the factory that builds the id they take (`WAWebWidFactory`), answers
 * `'missing'` before anything was asked of WhatsApp. Otherwise it answers the status WhatsApp gave, with the new code on a
 * 2xx: a rate limit or a server error removed nothing and is no refusal.
 */
export async function revokeInviteInPage(chatId: string): Promise<{ status: number; code?: string } | 'missing'> {
  type ResetJob = { resetGroupInviteCode: (wid: unknown) => Promise<{ code?: string } | undefined> };
  const w = window as unknown as { require: (m: string) => unknown };
  const find = <T>(name: string): T | undefined => {
    try {
      return w.require(name) as T | undefined;
    } catch (err) {
      if (typeof w.require !== 'function') throw err;
      return undefined;
    }
  };
  let job: ResetJob | undefined;
  for (const name of ['WAWebGroupInviteJob', 'WAWebGroupQueryJob']) {
    const found = find<Partial<ResetJob>>(name);
    if (typeof found?.resetGroupInviteCode === 'function') {
      job = found as ResetJob;
      break;
    }
  }
  const wids = find<{ createWid?: (id: string) => unknown }>('WAWebWidFactory');
  if (!job || typeof wids?.createWid !== 'function') return 'missing';
  try {
    const res = await job.resetGroupInviteCode(wids.createWid(chatId));
    return { status: 200, code: res?.code };
  } catch (err) {
    const refusal = err as { name?: unknown; status?: unknown } | undefined;
    if (refusal?.name === 'ServerStatusCodeError') {
      return { status: typeof refusal.status === 'number' ? refusal.status : 403 };
    }
    throw err;
  }
}

/**
 * GroupChat.getInviteCode, run IN-PAGE with the status mapping the revoke has. The library reads every rejection named
 * `ServerStatusCodeError` as "no code", which the adapter read as missing admin rights: a rate limit or a server error,
 * which only means the same request may pass later, was a 403, and a refusal of the Mex class
 * (`MexServerStatusCodeError`, which carries a status too) was a bare 500. This answers the status WhatsApp gave, with
 * the code on a 2xx. A build with no job to read the code answers `'missing'` before anything was asked, and the caller
 * runs the library's own call as it always did (see {@link NO_INVITE_JOB_ERRORS}). A document with no `require` at all
 * is a page that is reloading, not a build without the job, and that failure is let through. The plain error the job
 * throws when WhatsApp gave no code is answered as no code; any other rejection is rethrown.
 */
export async function readInviteCodeInPage(chatId: string): Promise<{ status: number; code?: string } | 'missing'> {
  type CodeJob = { fetchMexGroupInviteCode: (id: string) => Promise<{ code?: string } | string | undefined> };
  const w = window as unknown as { require: (m: string) => unknown };
  let job: Partial<CodeJob> | undefined;
  try {
    job = w.require('WAWebMexFetchGroupInviteCodeJob') as Partial<CodeJob> | undefined;
  } catch (err) {
    if (typeof w.require !== 'function') throw err;
  }
  if (typeof job?.fetchMexGroupInviteCode !== 'function') return 'missing';
  try {
    const res = await job.fetchMexGroupInviteCode(chatId);
    return { status: 200, code: typeof res === 'string' ? res : res?.code };
  } catch (err) {
    const refusal = err as { name?: unknown; status?: unknown; message?: unknown } | undefined;
    if (typeof refusal?.name === 'string' && refusal.name.endsWith('ServerStatusCodeError')) {
      return { status: typeof refusal.status === 'number' ? refusal.status : 403 };
    }
    // When WhatsApp answers with no code the job throws a plain error with no status: the same answer as a job that
    // resolves none, which the caller turns into the no-code refusal.
    if (typeof refusal?.message === 'string' && /\[MEX\]\[GROUP\][^\n]*invite code is null/.test(refusal.message)) {
      return { status: 200 };
    }
    throw err;
  }
}

/**
 * The join of the library's own `acceptInvite`, run IN-PAGE: `joinGroupViaInvite` of `WAWebGroupInviteJob`, called with
 * the invite code alone, as the library calls it, and read the way the library reads it (`res.gid._serialized ||
 * res.gid.$1`). The library does not look the job up, so on a build that has none it died in the page with a TypeError,
 * which the adapter read as a refused invite: the caller was told a valid link was bad. A build with no such job answers
 * `'missing'` before anything was asked of WhatsApp. A document with no `require` at all is a page that is reloading, not
 * a build without the job, and that failure is let through.
 *
 * The job answers a group that lets an admin approve new members with a membership request instead of a join, which
 * its response parser reads as an unexpected response (`UnexpectedJoinGroupViaInviteResponse`, with
 * `membershipApprovalMode` true when the response held the request): the invite was accepted as a request, and the
 * account has not joined. Puppeteer hands a page error over without its properties, so that is told apart here.
 *
 * A refusal, a rate limit, a timeout and a server error reject `ServerStatusCodeError(status)`, which Puppeteer hands over
 * without its status as well, so the status is answered here, as the invite code read answers it (a status-less error
 * as 403). Any other rejection is rethrown.
 */
export async function joinInviteInPage(
  inviteCode: string,
): Promise<{ gid?: string; requested?: true; status?: number } | 'missing'> {
  type Wid = { _serialized?: string; $1?: string };
  type JoinJob = { joinGroupViaInvite: (code: string) => Promise<{ gid?: Wid } | undefined> };
  const w = window as unknown as { require: (m: string) => unknown };
  let job: Partial<JoinJob> | undefined;
  try {
    job = w.require('WAWebGroupInviteJob') as Partial<JoinJob> | undefined;
  } catch (err) {
    if (typeof w.require !== 'function') throw err;
  }
  if (typeof job?.joinGroupViaInvite !== 'function') return 'missing';
  try {
    const res = await job.joinGroupViaInvite(inviteCode);
    return { gid: res?.gid?._serialized || res?.gid?.$1 };
  } catch (err) {
    const failure = err as { name?: unknown; membershipApprovalMode?: unknown; status?: unknown } | undefined;
    if (failure?.name === 'UnexpectedJoinGroupViaInviteResponse' && failure.membershipApprovalMode === true) {
      return { requested: true };
    }
    if (typeof failure?.name === 'string' && failure.name.endsWith('ServerStatusCodeError')) {
      return { status: typeof failure.status === 'number' ? failure.status : 403 };
    }
    throw err;
  }
}

/**
 * The preview of the library's own `getInviteInfo`, run IN-PAGE with the status WhatsApp gave: `queryGroupInvite` of
 * `WAWebGroupQueryJob`, called with the invite code as the library calls it, answering what it resolves. An invite
 * WhatsApp refuses, a rate limit, a timeout and a server error all reject `ServerStatusCodeError(status)`, which
 * Puppeteer hands over without its status, so all of them were the unknown invite. The library's call does not look the
 * job up, so on a build whose module lost `queryGroupInvite` it died in the page with a TypeError, which was read as
 * the unknown invite: every valid code was refused. From a page.evaluate Meta's `require` answers `undefined` for a
 * module the page has not defined, and throws only inside a guard or before the page's error setup has run, so the
 * lookup tests the answer and guards the throw; a build with no such job answers `'missing'` before anything was asked
 * of WhatsApp. A document with no `require` at all is a page that is reloading, not a build without the job, and that
 * failure is let through. The Mex job that a build runs in place of the IQ job makes up a 500 with no text at all when
 * its query answers no group and no error. That is no status WhatsApp sent but an answer that holds no group, so it is
 * the 404 of an unknown invite, where a 500 with a text is a failure to retry. Any rejection that is not a status is
 * rethrown. Self-contained, since Puppeteer ships it to the page as source.
 */
export async function readInviteInfoInPage(
  inviteCode: string,
): Promise<{ status: number; info?: unknown } | 'missing'> {
  type PreviewJob = { queryGroupInvite: (code: string) => Promise<unknown> };
  const w = window as unknown as { require: (m: string) => unknown };
  let job: Partial<PreviewJob> | undefined;
  try {
    job = w.require('WAWebGroupQueryJob') as Partial<PreviewJob> | undefined;
  } catch (err) {
    if (typeof w.require !== 'function') throw err;
  }
  if (typeof job?.queryGroupInvite !== 'function') return 'missing';
  try {
    return { status: 200, info: await job.queryGroupInvite(inviteCode) };
  } catch (err) {
    const failure = err as { name?: unknown; status?: unknown; message?: unknown } | undefined;
    if (typeof failure?.name === 'string' && failure.name.endsWith('ServerStatusCodeError')) {
      if (failure.status === 500 && failure.message === '') return { status: 404 };
      return { status: typeof failure.status === 'number' ? failure.status : 404 };
    }
    throw err;
  }
}

/**
 * How the library's own `getInviteCode` fails on a build with no job to read the code with. It reads the job's module
 * without asking, so a module that answers `undefined` is a TypeError, a module without the call is another, and the
 * `ModuleError` that Meta's `require` throws for a module the page has not defined (before its error setup has run)
 * carries the loader's own text, in which the module is a parameter and not part of the message. That is the only module
 * the library's call requires. Puppeteer hands the page's error over as a plain Error, so the message is what is matched,
 * and only the messages that say the module or its call is missing: any other failure is not this one.
 * `queryGroupInviteCode` is the call an older library reads.
 */
const NO_INVITE_JOB_ERRORS = [
  /Cannot read properties of undefined \(reading '(?:fetchMexGroupInviteCode|queryGroupInviteCode)'\)/,
  /\.(?:fetchMexGroupInviteCode|queryGroupInviteCode) is not a function/,
  /Requiring unknown module "%s"/,
];

/**
 * Whether the page still exports the invitation sender that `GroupChat.addParticipants` calls for a participant whose
 * privacy settings allow only an invitation: `sendGroupInviteMessage` of `WAWebChatSendMessages`. The build the gateway
 * selects today exports it from `WAWebChatSendGroupInviteMessage` instead, taking one options object where the library
 * passes positional arguments, so the library's call is a TypeError in its loop. From a page.evaluate Meta's `require`
 * answers `undefined` for a module the page has not defined, and throws only inside a guard or before the page's error
 * setup has run, so the lookup tests the answer and guards the throw. A document with no `require` at all is a page that
 * is reloading, not a build without the sender, and that failure is let through (spelled as the library spells it, which
 * is how the reload is read).
 */
export function readInviteSenderInPage(): boolean {
  type Messages = { sendGroupInviteMessage?: unknown } | undefined;
  let messages: Messages;
  try {
    messages = (window as unknown as { require: (m: string) => Messages }).require('WAWebChatSendMessages');
  } catch (err) {
    if (typeof (window as unknown as { require?: unknown }).require !== 'function') throw err;
  }
  return typeof messages?.sendGroupInviteMessage === 'function';
}

/**
 * Ask WhatsApp, IN-PAGE, to remove a group's picture, and answer the status it gave: 200, or the code it refused
 * with. `GroupChat.deletePicture` sends the same request but only when the page's own copy of the picture allows
 * it, and reads every refusal as `false`: a picture the page never loaded is then not deleted, a repeat of a
 * delete cannot be told from missing rights, and a rate limit reads as a refusal. The status says which it was. The
 * request is the same for the account's own picture, which `Client.deleteProfilePicture` reads the same way, so the id
 * may be the account's.
 *
 * Every lookup tests the answer and guards the throw: from a page.evaluate Meta's `require` answers `undefined` for a
 * module the page has not defined, and throws only inside a guard or before the page's error setup has run. A build with
 * no job to send the request, or no way to build the id it takes, answers `'missing'` before anything was asked of
 * WhatsApp; a document with no `require` at all is a page that is reloading, not such a build, and that failure is let
 * through. Self-contained, since Puppeteer ships it to the page as source.
 */
export async function deleteGroupPictureInPage(chatId: string): Promise<number | 'missing'> {
  type Bridge = { requestDeletePicture?: (wid: unknown) => Promise<unknown> };
  type Wids = { createWid?: (id: string) => unknown };
  const w = window as unknown as { require: (m: string) => unknown };
  const find = <T>(name: string): T | undefined => {
    try {
      return w.require(name) as T | undefined;
    } catch (err) {
      if (typeof w.require !== 'function') throw err;
      return undefined;
    }
  };
  const bridge = find<Bridge>('WAWebContactProfilePicThumbBridge');
  const wids = find<Wids>('WAWebWidFactory');
  if (typeof bridge?.requestDeletePicture !== 'function' || typeof wids?.createWid !== 'function') return 'missing';
  try {
    await bridge.requestDeletePicture(wids.createWid(chatId));
    return 200;
  } catch (err) {
    const refusal = err as { name?: string; status?: unknown } | undefined;
    if (refusal?.name === 'ServerStatusCodeError' && typeof refusal.status === 'number') return refusal.status;
    throw err;
  }
}

/**
 * Group-domain operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public
 * methods as thin forwarders and injects the shared host surface (./wwebjs-host) via closures,
 * so the delegate never touches lifecycle state directly.
 */
/**
 * Normalise whatsapp-web.js's member-add-mode to the neutral vocabulary.
 *
 * Deliberately handles both encodings. The WA Web group model — and GroupChat.setAddMembersAdminsOnly
 * when it writes back (GroupChat.js) — use WhatsApp's `'admin_add'`/`'all_member_add'` strings,
 * but index.d.ts declares the field `boolean` with `true` meaning "only admins", the OPPOSITE
 * sense to Baileys' boolean. Reading it as a plain boolean would therefore be wrong on both engines
 * for different reasons, so each shape is decoded explicitly and anything unrecognised is reported
 * as unknown rather than guessed.
 */
export function normalizeWwebjsMemberAddMode(raw: string | boolean | undefined): GroupMemberAddMode | undefined {
  if (raw === 'admin_add') return 'admins';
  if (raw === 'all_member_add') return 'all';
  // The documented (but not observed) boolean form: true = only admins may add.
  if (raw === true) return 'admins';
  if (raw === false) return 'all';
  return undefined;
}

/**
 * Normalise whatsapp-web.js's PascalCase request-method token to the neutral vocabulary.
 * Unrecognised tokens (a future WA Web build) are reported as unknown rather than guessed.
 */
export function normalizeWwebjsRequestMethod(raw: string | undefined): GroupMembershipRequestMethod | undefined {
  if (raw === 'InviteLink') return 'invite_link';
  if (raw === 'NonAdminAdd') return 'non_admin_add';
  if (raw === 'LinkedGroupJoin') return 'linked_group_join';
  return undefined;
}

export type ReadSelfLidResult = { ok: true; lid: string | null } | { ok: false };

/**
 * Read the account's own LID from WhatsApp Web's user-prefs module.
 * Distinguishes a loaded module (`{ ok: true, lid: string | null }`) from a page that is
 * mid-reload or has not yet loaded `window.require` / `WAWebUserPrefsMeUser` (`{ ok: false }`).
 * Self-contained so Puppeteer can serialize it into the page context.
 */
export function readSelfLidInPage(): ReadSelfLidResult {
  type Wid = { _serialized?: string; $1?: string };
  type MePrefs = { getMaybeMeLidUser?: () => Wid | null | undefined };
  const w = window as unknown as { require?: (m: string) => unknown };
  if (typeof w.require !== 'function') return { ok: false };
  try {
    const prefs = w.require('WAWebUserPrefsMeUser') as MePrefs | undefined;
    if (typeof prefs?.getMaybeMeLidUser !== 'function') return { ok: false };
    const lid = prefs.getMaybeMeLidUser();
    const serialized = lid?._serialized ?? lid?.$1 ?? null;
    return { ok: true, lid: typeof serialized === 'string' && serialized.length > 0 ? serialized : null };
  } catch {
    return { ok: false };
  }
}

function matchesSelfId(id: string | undefined, selfIds: ReadonlySet<string>): boolean {
  if (!id) return false;
  if (selfIds.has(id)) return true;
  const parsed = parseWaId(id);
  if (parsed.kind === 'user') return selfIds.has(`${parsed.userPart}@c.us`);
  if (parsed.kind === 'lid') return selfIds.has(`${parsed.userPart}@lid`);
  return false;
}

export class WwebjsGroups {
  private readonly selfLidCache = new WeakMap<Client, string>();

  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  private async resolveSelfIds(
    client: Client,
    participantIds: readonly string[],
    context: string,
    findPersistedLids?: (phone: string) => Promise<string[]>,
    pageLookupState?: { attempted: boolean },
  ): Promise<Set<string>> {
    const selfIds = new Set<string>();
    const addLid = (raw: string | null | undefined): void => {
      if (!raw) return;
      selfIds.add(raw);
      const lidUser = userPart(raw);
      if (lidUser) selfIds.add(`${lidUser}@lid`);
    };

    const info = client.info as { wid?: SerializedWid & { user?: string }; lid?: SerializedWid | string } | undefined;
    const selfWid = readWid(info?.wid);
    if (selfWid) {
      selfIds.add(selfWid);
    }
    const parsedWid = selfWid ? parseWaId(selfWid) : undefined;
    const phone =
      (parsedWid?.kind === 'user' ? parsedWid.userPart : undefined) ??
      (typeof info?.wid?.user === 'string' && info.wid.user ? info.wid.user : undefined);
    if (phone) {
      selfIds.add(`${phone}@c.us`);
      selfIds.add(`${phone}@s.whatsapp.net`);
    }
    addLid(readWid(info?.lid));

    const lidStore = this.host.config?.lidMappingStore;
    if (phone && lidStore) {
      for (const lid of lidStore.lidsForPhone(phone)) {
        addLid(lid);
      }
    }
    const cachedLid = this.selfLidCache.get(client);
    if (cachedLid) {
      addLid(cachedLid);
    }

    const hasMatch = (): boolean => participantIds.some(id => matchesSelfId(id, selfIds));
    const hasLidParticipant = participantIds.some(id => parseWaId(id).kind === 'lid');
    if (!hasLidParticipant || hasMatch()) {
      return selfIds;
    }

    if (phone && (findPersistedLids || lidStore?.findLidsForPhone)) {
      const persistedLids = await (
        findPersistedLids ? findPersistedLids(phone) : lidStore!.findLidsForPhone!(phone)
      ).catch(() => []);
      for (const lid of persistedLids) {
        addLid(lid);
      }
      if (hasMatch()) {
        return selfIds;
      }
    }

    if (!this.selfLidCache.has(client) && !pageLookupState?.attempted) {
      const page = (client as unknown as { pupPage?: EvaluatePage }).pupPage;
      if (typeof page?.evaluate === 'function') {
        if (pageLookupState) pageLookupState.attempted = true;
        const since = navigationsSeen(this.host);
        let result: ReadSelfLidResult = { ok: false };
        try {
          const raw: unknown = await page.evaluate(readSelfLidInPage);
          if (raw && typeof raw === 'object' && 'ok' in raw) {
            const parsed = raw as ReadSelfLidResult;
            result = parsed.ok
              ? { ok: true, lid: typeof parsed.lid === 'string' && parsed.lid.length > 0 ? parsed.lid : null }
              : { ok: false };
          } else if (typeof raw === 'string' && raw.length > 0) {
            result = { ok: true, lid: raw };
          }
        } catch (error) {
          if (typeof this.host.isPageTransportError === 'function') {
            rethrowIfNavigation(this.host, error, since);
            if (this.host.isPageTransportError(error)) {
              this.host.reportIfPageTransportError(error, context);
              throw new EngineTransportError(`Transport died during ${context}`);
            }
          }
          // Transient evaluation failure: do not poison selfLidCache with null.
          result = { ok: false };
        }
        if (!result.ok || result.lid === null) {
          throwIfNavigatedSince(this.host, since);
        } else {
          this.selfLidCache.set(client, result.lid);
          addLid(result.lid);
          if (phone && lidStore) {
            void Promise.resolve(lidStore.remember(userPart(result.lid), phone, this.host.config?.sessionId)).catch(
              () => undefined,
            );
          }
        }
      }
    }

    return selfIds;
  }

  async getGroups(): Promise<Group[]> {
    this.host.ensureReady();
    const client = this.client();
    const chats = await listChats(this.host, 'getGroups');

    // Filter only group chats
    const groups = chats.filter(chat => chat.isGroup);

    const lidStore = this.host.config?.lidMappingStore;
    let persistedLidsPromise: Promise<string[]> | undefined;
    const findPersistedLids = lidStore?.findLidsForPhone
      ? (phone: string): Promise<string[]> =>
          (persistedLidsPromise ??= lidStore.findLidsForPhone!(phone).catch(() => []))
      : undefined;
    const pageLookupState = { attempted: false };

    // List path: read linkedParentJID synchronously from whatever metadata the chat list
    // already loaded. We deliberately do NOT fall back to getChatById per group here:
    // that would be an N+1 round-trip across every group on every list call. Groups
    // whose metadata isn't loaded report null; the single-group endpoint (getGroupInfo,
    // which loads full metadata via getChatById) is the authoritative source.
    const results: Group[] = [];
    for (const g of groups) {
      const groupChat = g as unknown as GroupChat;
      const participantIds = (groupChat.participants ?? [])
        .map(p => readWid(p.id))
        .filter((id): id is string => id !== undefined);
      const selfIds = await this.resolveSelfIds(
        client,
        participantIds,
        'getGroups',
        findPersistedLids,
        pageLookupState,
      );
      results.push({
        id: g.id._serialized,
        name: g.name,
        participantsCount: groupChat.participants?.length,
        isAdmin: groupChat.participants?.some(
          p => (p.isAdmin || p.isSuperAdmin) && matchesSelfId(readWid(p.id), selfIds),
        ),
        linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
      });
    }
    return results;
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.host.ensureReady();
    const since = navigationsSeen(this.host);
    try {
      // A group whose refresh fails one of WhatsApp Web's own invariants is read from the metadata the
      // page already holds, as the group list reads it (readChatModels): as last loaded, not refreshed,
      // and without a last message, which this read does not use. Any other rejection falls to the catch.
      const chat = await this.client()
        .getChatById(groupId)
        .catch(error => recoverGroupChatById(this.host, 'getGroupInfo', groupId, error));
      if (!chat?.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      // Raw page-context Wids: read both property names, and DROP a participant whose id is
      // unreadable rather than emitting the literal string "undefined" as an addressable id.
      const participants: GroupParticipant[] = (groupChat.participants || [])
        .filter(p => readWid(p.id) !== undefined)
        .map(p => ({
          id: readWid(p.id)!,
          number: String(p.id.user),
          name: p.name ? String(p.name) : undefined,
          isAdmin: Boolean(p.isAdmin),
          isSuperAdmin: Boolean(p.isSuperAdmin),
        }));

      // GroupChat.createdAt is a getter returning a Date (GroupChat.js), which serialises as an
      // ISO string; the contract is Unix seconds, so read the raw metadata field instead.
      const creation = (groupChat.groupMetadata as { creation?: unknown } | undefined)?.creation;
      // GroupChat has no isAnnounce, and WA Web overwrites isReadOnly with the announce SETTING
      // (`WWebJS.getChatModel` in Injected/Utils.js), which tells an admin of an announce-only group they cannot post.
      // Derive both from the metadata, as the Baileys mapper does.
      const announce = Boolean(groupChat.groupMetadata?.announce);
      const selfIds = await this.resolveSelfIds(
        this.client(),
        participants.map(p => p.id),
        'getGroupInfo',
      );
      const selfIsAdmin = participants.some(p => (p.isAdmin || p.isSuperAdmin) && matchesSelfId(p.id, selfIds));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: readWid(groupChat.owner),
        createdAt: typeof creation === 'number' ? creation : undefined,
        participants,
        isReadOnly: announce && !selfIsAdmin,
        isAnnounce: announce,
        announce: groupChat.groupMetadata?.announce,
        locked: groupChat.groupMetadata?.restrict,
        ephemeralSeconds: groupChat.groupMetadata?.ephemeralDuration,
        memberAddMode: normalizeWwebjsMemberAddMode(groupChat.groupMetadata?.memberAddMode),
        linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
      };
    } catch (error) {
      // A session that went away during the read (the client is read again after the lookup), or a
      // transport death classified by resolveSelfIds, is not a missing group: propagate instead of 404.
      if (error instanceof EngineNotReadyError || error instanceof EngineTransportError) {
        throw error;
      }
      // A dead page and a genuinely-missing group both land in this catch; only the second may
      // become null (→ service 404). A transport death surfaced as "group not found" sends
      // operators debugging the wrong layer — report it and answer 503 instead.
      rethrowIfNavigation(this.host, error, since);
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getGroupInfo');
        throw new EngineTransportError(`Transport died while reading group ${groupId}`);
      }
      // A command that outran the protocol budget got no answer either way: a 503, but no death.
      if (isProtocolTimeout(error)) {
        throw new EngineTransportError(`WhatsApp Web did not answer the read of group ${groupId} in time`);
      }
      this.host.logger.warn(`Failed to get group: ${groupId}`, { error: String(error) });
      return null;
    }
  }

  /**
   * Not available on this engine, despite `Client.createGroup` existing and being typed
   * `Promise<CreateGroupResult | string>` (`index.d.ts`).
   *
   * Its page body reaches a WhatsApp Web internal that no longer exposes `findImpl`
   * (inside the evaluate of `Client.createGroup`). Measured against a live session on two
   * different WhatsApp Web builds — `2.3000.1044858477-alpha` auto-resolved from the registry, and
   * `2.3000.1044770897-alpha` pinned explicitly — with identical results:
   * `TypeError: this.findImpl is not a function`, reaching the caller as a bare 500. Bare and
   * `@c.us`-qualified participant ids fail the same way, so the id shape is not the variable.
   *
   * The build was varied deliberately because this registry pin moves on its own between restarts;
   * two builds failing the same way is what separates a library limitation from build drift. The
   * Baileys engine creates groups normally on the same account.
   *
   * Nothing here can be patched around: `findImpl` belongs to the page, not to whatsapp-web.js —
   * it appears in neither the installed `Client.js` nor any OpenWA patcher. Restore this method
   * when upstream adopts a page API that WhatsApp Web still provides.
   */
  /* eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  async createGroup(_name: string, _participants: string[]): Promise<Group> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('createGroup');
  }

  async addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    const chat = await this.requireGroupChat(groupId, 'addParticipants');
    const participantIds = participants.map(toParticipantWid);
    // Where the library's invitation sender is gone, its call would end the whole batch: add without the invitation,
    // which leaves the participant that needs one a 403 of its own. The question is a read made before anything is
    // sent, so it answers as the group lookup above does (a dead page or a timeout is a 503, a reload a 409); only the
    // add keeps the raw error of a write that does not converge.
    const invitesWork = await withPageWrite(this.host, 'addParticipants', () =>
      this.page().evaluate(readInviteSenderInPage),
    );
    const raw = await reportPageDeath(this.host, 'addParticipants', () =>
      invitesWork
        ? chat.addParticipants(participantIds)
        : chat.addParticipants(participantIds, { autoSendInviteV4: false }),
    );
    // whatsapp-web.js reports a batch-level refusal (no admin rights, empty group) by RESOLVING a
    // plain reason string (GroupChat.js) instead of throwing — surface it as a
    // refusal, not a success.
    if (typeof raw === 'string') {
      throw new EngineRefusedError(raw);
    }
    // Per-participant outcome: code 200 = added; 403 invite-only / 404 not registered / 408
    // recently left / 409 already a member / 419 group full (GroupChat.js).
    const results: ParticipantOperationResult[] = Object.entries(raw ?? {}).map(([id, r]) => {
      // A 403 with isInviteV4Sent is not a failure: wwebjs already delivered the private group
      // invite (GroupChat.js). Report it as success-with-invite — otherwise an all-invite
      // batch throws "failed for all" (HTTP 403) even though every participant was reached.
      const inviteSent = r.code === 403 && r.isInviteV4Sent === true;
      return {
        id,
        success: r.code === 200 || inviteSent,
        status: r.code,
        message: inviteSent
          ? 'the participant can only be added by private invitation — invite sent'
          : r.message || undefined,
      };
    });
    return this.assertParticipantResults('addParticipants', groupId, results);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runStatusOnlyParticipantOp('removeParticipants', groupId, participants);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runStatusOnlyParticipantOp('promoteParticipants', groupId, participants);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runStatusOnlyParticipantOp('demoteParticipants', groupId, participants);
  }

  /**
   * whatsapp-web.js resolves each requested id against the group's OWN participant collection and
   * silently drops what it cannot find (GroupChat.js), then resolves `{status: 200}` for the
   * whole batch. Reporting that as one success per requested participant claimed removals WhatsApp
   * never performed, and an all-dropped batch reached a request builder that asserts at least one
   * child — surfacing as an unnamed `500` (#1220).
   *
   * `scripts/patch-wwebjs-participant-arity.js` makes the page report `matched`, one boolean per
   * requested id, and skip the call when nothing resolved. An absent or wrong-length `matched` means
   * the installed tree is unpatched: keep the previous batch-confirmed shape rather than invent an
   * outcome, mirroring the `eventsAttached` marker convention from the ready-sync patcher. A batch
   * where nothing matched is a refusal of the operation itself (HTTP 403) via
   * {@link assertParticipantResults}.
   */
  private async runStatusOnlyParticipantOp(
    op: 'removeParticipants' | 'promoteParticipants' | 'demoteParticipants',
    groupId: string,
    participants: string[],
  ): Promise<ParticipantOperationResult[]> {
    const chat = await this.requireGroupChat(groupId, op);
    await this.refuseNonAdmin(chat, op, groupId);
    const participantIds = participants.map(toParticipantWid);
    const res = await this.runParticipantBatch(op, groupId, chat, participantIds);
    if (res?.status !== 200) {
      throw new EngineRefusedError(`${op} refused for group ${groupId} (status ${res?.status ?? 'unknown'})`);
    }
    const matched = Array.isArray(res.matched) && res.matched.length === participantIds.length ? res.matched : null;
    const results = participantIds.map((id, i) => {
      const resolved = matched ? matched[i] === true : true;
      return {
        id,
        success: resolved,
        status: resolved ? 200 : 404,
        message: resolved
          ? 'confirmed with the batch — wwebjs reports no per-participant outcome'
          : 'not a member of this group — WhatsApp was not asked to act on this participant',
      };
    });
    return this.assertParticipantResults(op, groupId, results);
  }

  /**
   * An unpatched tree hands the WA Web request builder an empty participant list when nothing
   * resolved, and its repeated-field arity assertion rejects. Classify ONLY that: anything else — a
   * closed target, a dead transport — must keep its own identity rather than be sold to the caller
   * as a permissions problem, the same rule the Baileys adapter states for its empty-results guard.
   */
  private async runParticipantBatch(
    op: 'removeParticipants' | 'promoteParticipants' | 'demoteParticipants',
    groupId: string,
    chat: GroupChat,
    participantIds: string[],
  ): Promise<{ status?: number; matched?: unknown }> {
    try {
      return await reportPageDeath(this.host, op, () => chat[op](participantIds));
    } catch (error) {
      if (/expected at least 1 children/.test((error as Error)?.message ?? '')) {
        throw new EngineRefusedError(`${op}: none of the requested participants is a member of group ${groupId}`);
      }
      throw error;
    }
  }

  /**
   * Shared gate for the membership writes: a result list with at least one success resolves as-is
   * (partial refusals stay visible per participant); a batch that failed for EVERY requested
   * participant is a refusal of the operation itself (HTTP 403), not a per-participant detail; and
   * an empty result is no evidence of success at all.
   */
  private assertParticipantResults(
    op: string,
    groupId: string,
    results: ParticipantOperationResult[],
  ): ParticipantOperationResult[] {
    if (results.length === 0) {
      throw new EngineRefusedError(`${op} returned no per-participant outcome for group ${groupId}`);
    }
    if (results.every(r => !r.success)) {
      const detail = results.map(r => `${r.id} (${r.status ?? '?'})`).join(', ');
      throw new EngineRefusedError(
        `${op} failed for all ${results.length} participant(s) in group ${groupId}: ${detail}`,
      );
    }
    return results;
  }

  async leaveGroup(groupId: string): Promise<void> {
    const chat = await this.requireGroupChat(groupId, 'leaveGroup');
    await reportPageDeath(this.host, 'leaveGroup', () => chat.leave());
  }

  /** The page of the client, for the writes the adapter sends itself. */
  private page(): EvaluatePage {
    return (this.client() as unknown as { pupPage: EvaluatePage }).pupPage;
  }

  /**
   * One write of the group settings, sent IN-PAGE so that WhatsApp's own status decides the answer: whatsapp-web.js
   * reads every status as `false`, which this adapter read as missing admin rights, so a rate limit or a server error
   * (nothing was changed, the same request may pass later) was a 403. A page that cannot run the write answers before
   * anything was sent: a page without whatsapp-web.js's helpers is reloading, which is the retryable 409, and a build
   * without the job is the 501 that `unsupported` builds (one per write, so that the parity gate reads each as a
   * conditional refusal). The library's own call needs the same modules and helpers, so it is not tried. `refusal` words
   * a refusal. Every write here converges when repeated. `unchanged` says what a rate limit or a server error left, for
   * the write that can be applied in part.
   */
  private async write(
    op: string,
    request: PageWrite,
    what: string,
    refusal: string,
    unsupported: () => EngineNotSupportedError,
    unchanged = 'changed nothing',
  ): Promise<void> {
    const answer = await withPageWrite(this.host, op, () => this.page().evaluate(runWriteInPage, request));
    if (answer === 'no-helpers') throw new EnginePageReloadingError();
    if (answer === 'missing') throw unsupported();
    settleWriteStatus(
      answer.status,
      {
        request: what,
        nothing: unchanged,
        refused: (status, local) =>
          local
            ? `${refusal}: the page says this account may not change it, nothing was sent`
            : `${refusal}: WhatsApp refused it (${status}), as when admin rights are required`,
      },
      answer.local,
    );
  }

  // Every setter below resolves the group first (the 404 and the not-ready 409 come from there) and then sends the
  // write in the page: a refusal WhatsApp gives is its status, not a false that reads as a silent success.
  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    await this.requireGroupChat(groupId, 'setGroupSubject');
    await this.write(
      'setGroupSubject',
      { kind: 'subject', chatId: groupId, subject },
      `the subject change for group ${groupId}`,
      `Failed to set the subject for group ${groupId}`,
      () => new EngineNotSupportedError('setGroupSubject(no write job on this build)'),
    );
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    await this.requireGroupChat(groupId, 'setGroupDescription');
    await this.write(
      'setGroupDescription',
      { kind: 'description', chatId: groupId, description },
      `the description change for group ${groupId}`,
      `Failed to set the description for group ${groupId}`,
      () => new EngineNotSupportedError('setGroupDescription(no write job on this build)'),
    );
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    const chat = await this.requireGroupChat(groupId, 'getGroupInviteCode');
    const since = navigationsSeen(this.host);
    // Read in the page, so that WhatsApp's own status decides the answer: a rate limit or a server error is a 503, a
    // refusal a 403. A page with no job to read it with is the library's own call, as it always was.
    const answer = await withPageWrite(this.host, 'getGroupInviteCode', () =>
      this.page().evaluate(readInviteCodeInPage, groupId),
    );
    let inviteCode: string | undefined;
    if (answer === 'missing') {
      inviteCode = await withPageWrite(this.host, 'getGroupInviteCode', () => chat.getInviteCode()).catch(
        (error: unknown) => {
          // Read after withPageWrite, so a navigation, a dead page and a timeout are answered by now. The library dying
          // for want of the job asked nothing of WhatsApp and this build has no other way to read the code: the 501 the
          // revoke answers, not a bare 500. Every other failure keeps its answer.
          const message = error instanceof Error ? error.message : String(error);
          if (!NO_INVITE_JOB_ERRORS.some(pattern => pattern.test(message))) throw error;
          // A page that reloaded during the read has not booted its modules yet either: that is the 409.
          rethrowIfNavigation(this.host, error, since);
          throw new EngineNotSupportedError('getGroupInviteCode(no invite code job on this build)');
        },
      );
    } else {
      settleWriteStatus(answer.status, {
        request: `the invite code read for group ${groupId}`,
        nothing: 'gave no code',
        refused: refusedWith =>
          `Failed to get the invite code for group ${groupId}: WhatsApp refused it (${refusedWith}), as when admin ` +
          'rights are required',
      });
      inviteCode = answer.code;
    }
    // Typed Promise<string>, but WA Web yields nothing when the account is not an admin of the
    // group — and String(undefined) is the literal 'undefined', which the caller renders as the
    // link "https://chat.whatsapp.com/undefined". Same refusal contract as setDescription.
    if (!inviteCode) {
      throw new EngineRefusedError(`Failed to get the invite code for group ${groupId} — admin rights required`);
    }
    this.host.logger.debug('Got group invite code', { groupId });
    return inviteCode;
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    await this.requireGroupChat(groupId, 'revokeGroupInviteCode');
    const since = navigationsSeen(this.host);
    const answer = await reportPageDeath(this.host, 'revokeGroupInviteCode', () =>
      this.page().evaluate(revokeInviteInPage, groupId),
    ).catch((error: unknown) => {
      // The page function reads `require` first, so a document that has none ends it before anything was asked of
      // WhatsApp: the one failure here that proves the code was not rotated, and so the retryable 409. Every other
      // failure, a navigation that cut the call included, leaves the outcome unknown and keeps the raw error.
      if (isMissingRequireError(error)) throw new EnginePageReloadingError();
      throw error;
    });
    // A build with no job to reset a code: nothing was asked of WhatsApp, so this is no refusal and no failure. A
    // document a reload has just opened finds no job either, and that is the retryable 409.
    if (answer === 'missing') {
      throwIfNavigatedSince(this.host, since);
      throw new EngineNotSupportedError('revokeGroupInviteCode(no reset job on this build)');
    }
    // A status answer means WhatsApp refused it and rotated nothing, so a repeat converges: the 503 is safe here, where
    // a transport death is not (see reportPageDeath).
    settleWriteStatus(answer.status, {
      request: `the invite code revoke for group ${groupId}`,
      nothing: 'kept the current code',
      refused: refusedWith =>
        `Failed to revoke the invite code for group ${groupId}: WhatsApp refused it (${refusedWith}), as when admin ` +
        'rights are required',
    });
    if (!answer.code) {
      throw new EngineRefusedError(`Failed to revoke the invite code for group ${groupId} — admin rights required`);
    }
    this.host.logger.debug('Revoked group invite code, new code generated', { groupId });
    return answer.code;
  }

  /**
   * Preview a group from its invite code.
   *
   * `Client.getInviteInfo` is typed `Promise<object>` and forwards whatever WA Web's
   * `queryGroupInvite` returns, so there is no contract to rely on — every field is read
   * defensively and omitted when absent rather than defaulted into something that reads as fact.
   * The one thing that IS required is an id: without it there is no group to describe, which means
   * the invite was refused (invalid, expired or revoked) rather than that a field is missing.
   *
   * The preview is read in the page ({@link readInviteInfoInPage}), so that the status WhatsApp gave decides the answer:
   * a timeout, a rate limit or a server error is a 503 where it was the unknown invite, and any other status is the 404.
   * A build whose job module has no preview call is the 501, and the code is not judged.
   */
  async getGroupJoinInfo(inviteCode: string): Promise<GroupJoinInfo> {
    this.host.ensureReady();
    type RawInviteInfo = {
      id?: { _serialized?: string; $1?: string } | string;
      subject?: string;
      desc?: string;
      owner?: { _serialized?: string; $1?: string } | string;
      creation?: number;
      size?: number;
      participants?: unknown[];
    } | null;
    // A refused invite (invalid, expired, revoked) rejects PAGE-SIDE inside WA Web's query job with the status WhatsApp
    // gave, which the page function answers: a rejection that reached here unmapped escaped as an opaque 500 for the
    // endpoint's most common error input, which the route documents (and Baileys answers) as 404. The sibling
    // joinGroupViaInviteCode maps the same cause; this is the read half.
    let answer: Awaited<ReturnType<typeof readInviteInfoInPage>>;
    const since = navigationsSeen(this.host);
    try {
      answer = await this.page().evaluate(readInviteInfoInPage, inviteCode);
    } catch (error) {
      // A dead page and a refused invite both land here; only the second is a 404. Folding a
      // transport death into "no such invite" sends operators debugging the wrong layer.
      rethrowIfNavigation(this.host, error, since);
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getGroupJoinInfo');
        throw new EngineTransportError(`Transport died while previewing invite ${inviteCode}`);
      }
      if (isProtocolTimeout(error)) {
        throw new EngineTransportError(`WhatsApp Web did not answer the preview of invite ${inviteCode} in time`);
      }
      this.host.logger.debug('The invite preview was rejected; treating the invite as not found', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new GroupNotFoundError(inviteCode);
    }
    // A build with no job to preview with: nothing was asked of WhatsApp, so the code was not judged and this is no
    // unknown invite. A document a reload has just opened finds no job either, and that is the retryable 409.
    if (answer === 'missing') {
      throwIfNavigatedSince(this.host, since);
      throw new EngineNotSupportedError('getGroupJoinInfo(no invite preview job on this build)');
    }
    // A timeout, a rate limit or a server error read nothing, and the same code may pass a moment later: the retryable
    // 503, as on Baileys. Any other status is the refused invite. Settled outside the try, which reads a failure of the
    // call itself.
    settleWriteStatus(answer.status, {
      request: `the preview of invite ${inviteCode}`,
      nothing: 'returned no group',
      refused: () => {
        throw new GroupNotFoundError(inviteCode);
      },
    });
    const raw = answer.info as RawInviteInfo;

    // Raw page-context Wids: read `$1` before concluding absence (#747, the WA Web minifier
    // rename) — without the fallback a renamed build turns every VALID invite into a false 404.
    const id = readWid(raw?.id);
    if (!id) {
      throw new GroupNotFoundError(inviteCode);
    }
    const owner = readWid(raw?.owner);
    // `size` is the disclosed count; a participants array is used only as a fallback for builds that
    // send one instead. Neither is synthesised when both are missing.
    const count = typeof raw?.size === 'number' ? raw.size : raw?.participants?.length;

    return {
      id,
      name: String(raw?.subject ?? ''),
      ...(raw?.desc ? { description: String(raw.desc) } : {}),
      ...(owner ? { owner } : {}),
      ...(typeof raw?.creation === 'number' ? { createdAt: raw.creation } : {}),
      ...(typeof count === 'number' ? { participantCount: count } : {}),
    };
  }

  async joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    this.host.ensureReady();
    // The job answers a refused invite (invalid/expired/revoked) by rejecting page-side, and otherwise resolves the joined
    // group's id (`res.gid._serialized || res.gid.$1`) - already the neutral `<id>@g.us` dialect. A gid-less result is
    // the same client-facing outcome as a thrown refusal: no such invite (400, not a 500).
    let answer: Awaited<ReturnType<typeof joinInviteInPage>> | undefined;
    const since = navigationsSeen(this.host);
    try {
      answer = await this.page().evaluate(joinInviteInPage, inviteCode);
    } catch (error) {
      // A refused invite and a broken page both land here, and only the first is the caller's
      // fault. A transport death must not be reported as "invalid invite" (400): report the death
      // to the liveness path and answer 503 so the caller can tell the layers apart.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'joinGroupViaInviteCode');
        throw new EngineTransportError('Transport died while accepting the group invite');
      }
      // The join may still land WhatsApp-side, so this is the route's "may or may not have been
      // applied" 503, never "invalid invite".
      if (isProtocolTimeout(error)) {
        throw new EngineTransportError('WhatsApp Web did not answer the group invite acceptance in time');
      }
      // A reload cut the call: the same unknown outcome, and not a refused invite either. A navigation stamped
      // during the call counts whatever the failure says, as for every other call that a reload lands on.
      if (isNavigationError(error, navigationsSeen(this.host) !== since)) {
        throw new EngineTransportError('WhatsApp Web reloaded its page during the group invite acceptance');
      }
      this.host.logger.warn(`Failed to accept group invite: ${String(error)}`);
    }
    // A build with no job to join with: nothing was asked of WhatsApp, so this is no refused invite and no failure. A
    // document a reload has just opened finds no job either, and that is the retryable 409.
    if (answer === 'missing') {
      throwIfNavigatedSince(this.host, since);
      throw new EngineNotSupportedError('joinGroupViaInviteCode(no join job on this build)');
    }
    // The group has an admin approve new members: WhatsApp took the invite as a request to join, so the invite is good.
    if (answer?.requested) {
      throw new BadRequestException(
        'could not join the group: it needs an admin to approve new members, and a request to join was sent',
      );
    }
    // WhatsApp answered the join with a status. A timeout, a rate limit or a server error joined nothing, and the same
    // code may pass a moment later: the retryable 503, as on Baileys. Any other status is the refused invite, the 400.
    if (answer?.status !== undefined) {
      this.host.logger.warn('WhatsApp answered the group join with a status', { status: answer.status });
      settleWriteStatus(answer.status, {
        request: 'the group join',
        nothing: 'joined nothing',
        refused: () => {
          throw new InvalidInviteCodeError();
        },
      });
    }
    const groupId = answer?.gid;
    if (!groupId) {
      throw new InvalidInviteCodeError();
    }
    this.host.logger.debug('Joined group via invite code', { groupId });
    return groupId;
  }

  /**
   * Resolve a group chat or throw: the shared preamble of the group settings writes. The lookup is a
   * read that runs before any write, so a dead page answers 503 with the death signal, and a lookup that
   * outran the protocol budget answers 503 without one, even for the non-idempotent callers: nothing has
   * been applied yet. A session that went away during the lookup answers the not-ready 409 for the same
   * reason. `context` names the caller's operation.
   */
  private async requireGroupChat(groupId: string, context: string): Promise<GroupChat> {
    this.host.ensureReady();
    const chat = await withPageWrite(this.host, context, () =>
      this.client()
        .getChatById(groupId)
        .catch(error => recoverGroupChatById(this.host, context, groupId, error)),
    );
    // getChatById RESOLVES undefined for an unknown id (wwebjs does not throw): unknown id and a
    // non-group id are the same client-facing outcome — there is no such group (404, not a 500).
    if (!chat?.isGroup) {
      throw new GroupNotFoundError(groupId);
    }
    // The write goes out on the chat's own client right after this, which the host's getClient never
    // sees, so a teardown that landed in the lookup must be caught here.
    this.host.ensureReady();
    return chat as unknown as GroupChat;
  }

  /**
   * Refuse up front (403) when the account is a member of the group that is neither admin nor superadmin. The remove,
   * promote and demote page bodies answer a fixed status whatever WhatsApp decided, so the routes' documented 403 can
   * only come from here. An account the participant list does not name (another id dialect) goes ahead as before.
   */
  private async refuseNonAdmin(chat: GroupChat, op: string, groupId: string): Promise<void> {
    const participantIds = (chat.participants ?? [])
      .map(p => readWid(p.id))
      .filter((id): id is string => id !== undefined);
    const selfIds = await this.resolveSelfIds(this.client(), participantIds, op);
    // Teardown or disconnect can land during async self-LID resolution; fail before mutating participants.
    this.host.ensureReady();
    const me = selfIds.size === 0 ? undefined : chat.participants?.find(p => matchesSelfId(readWid(p.id), selfIds));
    if (me && !me.isAdmin && !me.isSuperAdmin) {
      throw new EngineRefusedError(`${op} refused for group ${groupId}: this account is not an admin of the group`);
    }
  }

  // Set "only admins can send messages" (announce)
  async setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    await this.requireGroupChat(groupId, 'setGroupMessagesAdminsOnly');
    await this.write(
      'setGroupMessagesAdminsOnly',
      { kind: 'property', chatId: groupId, property: 'announcement', value: adminsOnly ? 1 : 0 },
      `the messages-admins-only change for group ${groupId}`,
      `Failed to update the messages-admins-only setting for group ${groupId}`,
      () => new EngineNotSupportedError('setGroupMessagesAdminsOnly(no write job on this build)'),
    );
  }

  async setGroupPicture(groupId: string, media: MediaInput): Promise<void> {
    await this.requireGroupChat(groupId, 'setGroupPicture');
    // Loaded outside the page guard: a media fetch failing with "connection closed" is not a dead page.
    const picture = await toMessageMedia(media, this.host.config.proxy?.url);
    // The fetch can outlast the session, and the write goes out through the client that read the group.
    this.host.ensureReady();
    // The picture of the group, not of the own account (setProfilePicture).
    await this.write(
      'setGroupPicture',
      { kind: 'picture', chatId: groupId, picture },
      `the picture change for group ${groupId}`,
      `Failed to set the picture for group ${groupId}`,
      () => new EngineNotSupportedError('setGroupPicture(no write job on this build)'),
    );
  }

  async deleteGroupPicture(groupId: string): Promise<void> {
    await this.requireGroupChat(groupId, 'deleteGroupPicture');
    const since = navigationsSeen(this.host);
    const status = await withPageWrite(this.host, 'deleteGroupPicture', () =>
      this.page().evaluate(deleteGroupPictureInPage, groupId),
    );
    // A build with no job to send the delete: nothing was asked of WhatsApp, so this is no refusal and no failure. A
    // document a reload has just opened finds no job either, and that is the retryable 409.
    if (status === 'missing') {
      throwIfNavigatedSince(this.host, since);
      throw new EngineNotSupportedError('deleteGroupPicture(no picture delete job on this build)');
    }
    this.host.logger.debug('WhatsApp answered the group picture delete', { groupId, status });
    // WhatsApp answers 200 for a group with no picture as for one it removed, so a repeat converges. A rate limit or
    // a server error deleted nothing, and the same request may pass later.
    settleWriteStatus(status, {
      request: `the picture delete for group ${groupId}`,
      nothing: 'removed nothing',
      refused: refusedWith =>
        `Failed to delete the picture for group ${groupId}: WhatsApp refused it (${refusedWith}), as when admin rights ` +
        'are required',
    });
  }

  // Set who may add participants: the property `member_add_mode` is 0 for admins only and 1 for every member. It is
  // not a groupSettingUpdate option on either engine.
  async setGroupMemberAddMode(groupId: string, mode: GroupMemberAddMode): Promise<void> {
    await this.requireGroupChat(groupId, 'setGroupMemberAddMode');
    await this.write(
      'setGroupMemberAddMode',
      { kind: 'property', chatId: groupId, property: 'member_add_mode', value: mode === 'admins' ? 0 : 1 },
      `the member-add-mode change for group ${groupId}`,
      `Failed to update the member-add-mode setting for group ${groupId}`,
      () => new EngineNotSupportedError('setGroupMemberAddMode(no write job on this build)'),
      // Setting admins on a group whose link mode is open is two writes in the page, and the second can fail after the
      // first was applied.
      'it may have been applied in part',
    );
  }

  // Set "only admins can edit group info" (locked/restrict)
  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    await this.requireGroupChat(groupId, 'setGroupInfoAdminsOnly');
    await this.write(
      'setGroupInfoAdminsOnly',
      { kind: 'property', chatId: groupId, property: 'restrict', value: adminsOnly ? 1 : 0 },
      `the info-admins-only change for group ${groupId}`,
      `Failed to update the info-admins-only setting for group ${groupId}`,
      () => new EngineNotSupportedError('setGroupInfoAdminsOnly(no write job on this build)'),
    );
  }

  // whatsapp-web.js 1.34.8 exposes no disappearing-messages setter (no Client/GroupChat symbol in
  // index.d.ts; only a create-time messageTimer option, Client.js createGroup) — an honest 501, not a no-op.
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async setGroupEphemeral(_groupId: string, _durationSec: number): Promise<void> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('setGroupEphemeral');
  }

  // whatsapp-web.js 1.34.8 has no member-label setter (no memberLabel or member tag symbol in index.d.ts
  // or src/), so this is an honest 501 rather than a no-op.
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async setGroupMemberLabel(_groupId: string, _label: string): Promise<void> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('setGroupMemberLabel');
  }

  async getGroupMembershipRequests(groupId: string): Promise<GroupMembershipRequest[]> {
    // Resolved first, like every other group operation in this file. Without it an unknown id or a
    // non-group jid answered 200 with an empty list, which reads as "this group has no pending
    // requests" rather than "there is no such group"; Baileys answers the refusal.
    const chat = await this.requireGroupChat(groupId, 'getGroupMembershipRequests');
    // The library reads the page's own request store, which answers a non-admin without asking WhatsApp.
    await this.refuseNonAdmin(chat, 'getGroupMembershipRequests', groupId);
    return withPageWrite(this.host, 'getGroupMembershipRequests', async () => {
      const raw = await this.client().getGroupMembershipRequests(groupId);
      // Raw page-context store objects: wids can arrive as {_serialized} OR {$1} (the #747
      // minifier rename), so every id goes through readWid; a requester whose wid is unreadable
      // is dropped rather than reported as the literal "undefined".
      return (raw ?? []).flatMap(entry => {
        const e = entry as unknown as {
          id?: SerializedWid | string;
          addedBy?: SerializedWid | string;
          requestMethod?: string;
          t?: number;
        };
        const participantId = readWid(e.id);
        if (!participantId) {
          return [];
        }
        const addedById = readWid(e.addedBy);
        const method = normalizeWwebjsRequestMethod(e.requestMethod);
        return [
          {
            participantId,
            ...(addedById ? { addedById } : {}),
            ...(method ? { method } : {}),
            ...(typeof e.t === 'number' ? { requestedAt: e.t } : {}),
          },
        ];
      });
    });
  }

  approveGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    return this.runMembershipRequestAction('approveGroupMembershipRequests', groupId, participants);
  }

  rejectGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    return this.runMembershipRequestAction('rejectGroupMembershipRequests', groupId, participants);
  }

  /**
   * Shared body of the approve/reject writes. The upstream default sleep (a human-ish 250-500ms
   * pause between requesters) is restated explicitly so a wwebjs default change cannot silently
   * alter this gateway's pacing. The membership-write guards (assertParticipantResults) apply only
   * when the caller NAMED requesters: acting on "all pending" of an empty queue is a legitimate
   * no-op that resolves [], not a refusal.
   */
  private async runMembershipRequestAction(
    op: 'approveGroupMembershipRequests' | 'rejectGroupMembershipRequests',
    groupId: string,
    participants?: string[],
  ): Promise<ParticipantOperationResult[]> {
    // Resolved first, like the list above: the page reads the group's metadata without checking it
    // exists, so an unknown or non-group id rejected there and answered 500 instead of 404.
    const chat = await this.requireGroupChat(groupId, op);
    // Naming nobody takes every pending request from the page's own store, which answers a non-admin with an empty
    // list, as the read above does. Named requesters get the server's per-requester answer.
    if (!participants) await this.refuseNonAdmin(chat, op, groupId);
    const options = {
      // Qualified like every other participant write in this file: the service blesses a bare phone
      // number, and the page maps requesterIds straight through `createWid` (Injected/Utils.js) —
      // which upstream itself never hands a bare number, appending '@c.us' first. Unqualified it
      // threw inside the minified bundle and the caller got an undiagnosable 500, while the same
      // input succeeded on Baileys. `null` still means every pending request.
      requesterIds: participants?.map(toParticipantWid) ?? null,
      sleep: [250, 500],
    };
    const raw = await reportPageDeath(this.host, op, () => this.client()[op](groupId, options));
    // {requesterId, error?, message} per requester; requesterId is a page-context value that can
    // arrive as a string or a wid object (both #747 spellings), so it goes through readWid too.
    // "No error field" is NOT sufficient for success: the page util's non-success RPC branch pushes
    // {requesterId, message: 'ServerStatusCodeError'} with no code at all (`WWebJS.membershipRequestAction` in Injected/Utils.js).
    const results: ParticipantOperationResult[] = (raw ?? []).map(entry => {
      const e = entry as unknown as { requesterId?: SerializedWid | string | null; error?: number; message?: string };
      return {
        id: readWid(e.requesterId ?? undefined) ?? '',
        success: e.error === undefined && e.message !== 'ServerStatusCodeError',
        ...(e.error !== undefined ? { status: e.error } : {}),
        ...(e.message ? { message: e.message } : {}),
      };
    });
    if (!participants) {
      return results;
    }
    return this.assertParticipantResults(op, groupId, results);
  }
}
