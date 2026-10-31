import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { REQUIRED_ROLE_KEY } from './decorators/auth.decorators';
import { ApiKeyRole } from './entities/api-key.entity';
import { IntegrationInstanceController } from '../integration/integration-instance.controller';
import { RedriveController } from '../integration/redrive.controller';
import { GroupController } from '../group/group.controller';
import { ContactController } from '../contact/contact.controller';
import { ChannelController } from '../channel/channel.controller';
import { LabelController } from '../label/label.controller';
import { ProfileController } from '../profile/profile.controller';
import { CatalogController } from '../catalog/catalog.controller';
import { MessageController } from '../message/message.controller';
import { SessionController } from '../session/session.controller';
import { allAgentTools } from '../../core/agent-tools/tools';

// The dashboard's client-side role (seeded from localStorage) is cosmetic UX only — the ACTUAL
// authorization boundary is the backend @RequireRole guard. These assertions lock that the sensitive
// ADMIN-only integration provisioning / redrive surfaces are role-gated server-side at the class level,
// so a tampered client role can never reach them regardless of what the browser claims.
describe('admin controller role coverage (server-side authorization is the real gate)', () => {
  it.each([
    ['IntegrationInstanceController', IntegrationInstanceController],
    ['RedriveController', RedriveController],
  ])('%s requires the ADMIN role at the class level', (_name, controller) => {
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, controller)).toBe(ApiKeyRole.ADMIN);
  });
});

// A group invite code is a bearer capability, not read data: whoever holds the link joins the group
// on WhatsApp with no OpenWA credential at all, and that membership survives revoking the key that
// fetched the code. Both invite-code routes therefore sit at OPERATOR, like the QR endpoint: the
// reads whose payload is a credential for a system outside OpenWA's authority.
describe('group invite-code role coverage (the code is a capability, not read data)', () => {
  it.each(['getInviteCode', 'revokeInviteCode'] as const)('GroupController.%s requires the OPERATOR role', method => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, GroupController.prototype[method])).toBe(ApiKeyRole.OPERATOR);
  });
});

// A number-existence check is an outbound WhatsApp query about a third party, and bulk checks put the
// linked account's standing at risk, so it sits at OPERATOR (the MCP ContactCheckNumber tool too).
// The profile-picture and phone-resolution reads stay open to any key: the dashboard loads avatars
// with a VIEWER key.
describe('contact lookup role coverage', () => {
  it('ContactController.checkNumber requires the OPERATOR role', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, ContactController.prototype.checkNumber)).toBe(ApiKeyRole.OPERATOR);
  });

  it.each(['getProfilePictures', 'getProfilePicture', 'resolvePhone'] as const)(
    'ContactController.%s stays open to any valid key',
    method => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, ContactController.prototype[method])).toBeUndefined();
    },
  );
});

const atLeastOperator = (role?: ApiKeyRole): boolean => role === ApiKeyRole.OPERATOR || role === ApiKeyRole.ADMIN;

// A write route that loses its role gate is open to a read-only VIEWER key and nothing else notices: the
// handler still works and every other gate stays green. So this walks the routes instead of naming them.
// Every handler of these controllers that is not a plain read must require OPERATOR or higher, on the
// handler or on the class. A deliberate exception goes in OPEN_WRITES, keyed `Controller.handler`, with why.
describe('write routes of the channel, group, contact, label, profile and catalog controllers', () => {
  const CONTROLLERS = [
    ChannelController,
    GroupController,
    ContactController,
    LabelController,
    ProfileController,
    CatalogController,
  ];
  const OPEN_WRITES = new Map<string, string>();
  const READS = [RequestMethod.GET, RequestMethod.HEAD, RequestMethod.OPTIONS];

  const writeRoutes = CONTROLLERS.flatMap(controller =>
    Object.getOwnPropertyNames(controller.prototype).flatMap(name => {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
      if (typeof handler !== 'function') return [];
      // RequestMethod.GET is 0, so "is a route" is an undefined check, not a truthiness check.
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined || READS.includes(method)) return [];
      const role = (Reflect.getMetadata(REQUIRED_ROLE_KEY, handler) ??
        Reflect.getMetadata(REQUIRED_ROLE_KEY, controller)) as ApiKeyRole | undefined;
      return [{ id: `${controller.name}.${name}`, role }];
    }),
  );

  it('walks the write routes of every controller (a walk that found none would pass for the wrong reason)', () => {
    // 35 when written: channel 7, group 15, contact 4, label 4, profile 4, catalog 1.
    expect(writeRoutes.length).toBeGreaterThanOrEqual(35);
    for (const controller of CONTROLLERS) {
      expect(writeRoutes.some(route => route.id.startsWith(`${controller.name}.`))).toBe(true);
    }
  });

  it('requires OPERATOR or higher on every write route', () => {
    const open = writeRoutes.filter(route => !atLeastOperator(route.role) && !OPEN_WRITES.has(route.id));
    expect(open.map(route => route.id)).toEqual([]);
  });

  it('keeps no allowance for a route that is gated or gone', () => {
    const stale = [...OPEN_WRITES.keys()].filter(
      id => !writeRoutes.some(route => route.id === id && !atLeastOperator(route.role)),
    );
    expect(stale).toEqual([]);
  });
});

// The message and session controllers drive the linked WhatsApp account: they send, delete, start, stop,
// log out, hand out the QR code and pair a number. The walk above only asks that a write route is gated at
// all, so it would not see the QR read slipping below OPERATOR, the proxy write sliding from ADMIN to
// OPERATOR, or the presence read losing its explicit VIEWER. These tables state every route's role, so
// removing or changing one mark fails here, and a new route fails until its role is decided.
describe('role of every message and session route', () => {
  const OPEN = 'open'; // no @RequireRole: any valid key may call it
  type Role = ApiKeyRole | typeof OPEN;

  const MESSAGE_ROLES: Record<string, Role> = {
    getMessages: OPEN,
    sendText: ApiKeyRole.OPERATOR,
    sendTemplate: ApiKeyRole.OPERATOR,
    sendImage: ApiKeyRole.OPERATOR,
    sendVideo: ApiKeyRole.OPERATOR,
    sendAudio: ApiKeyRole.OPERATOR,
    sendDocument: ApiKeyRole.OPERATOR,
    sendLocation: ApiKeyRole.OPERATOR,
    sendContact: ApiKeyRole.OPERATOR,
    sendSticker: ApiKeyRole.OPERATOR,
    sendPoll: ApiKeyRole.OPERATOR,
    reply: ApiKeyRole.OPERATOR,
    clickButton: ApiKeyRole.OPERATOR,
    forward: ApiKeyRole.OPERATOR,
    react: ApiKeyRole.OPERATOR,
    getBatchStatus: OPEN,
    cancelBatch: ApiKeyRole.OPERATOR,
    getChatHistory: OPEN,
    getReactions: OPEN,
    getChatMedia: OPEN,
    deleteMessage: ApiKeyRole.OPERATOR,
    votePoll: ApiKeyRole.OPERATOR,
    pinMessage: ApiKeyRole.OPERATOR,
    unpinMessage: ApiKeyRole.OPERATOR,
    starMessage: ApiKeyRole.OPERATOR,
    edit: ApiKeyRole.OPERATOR,
    sendBulk: ApiKeyRole.OPERATOR,
  };

  const SESSION_ROLES: Record<string, Role> = {
    create: ApiKeyRole.OPERATOR,
    findAll: OPEN,
    findOne: OPEN,
    getConfig: OPEN,
    updateConfig: ApiKeyRole.OPERATOR,
    getProxy: OPEN,
    updateProxy: ApiKeyRole.ADMIN,
    delete: ApiKeyRole.OPERATOR,
    start: ApiKeyRole.OPERATOR,
    stop: ApiKeyRole.OPERATOR,
    logout: ApiKeyRole.OPERATOR,
    forceKill: ApiKeyRole.OPERATOR,
    // A GET, but the QR code links a device to the account, like the invite codes above.
    getQRCode: ApiKeyRole.OPERATOR,
    requestPairingCode: ApiKeyRole.OPERATOR,
    getGroups: OPEN,
    getChats: OPEN,
    markChatRead: ApiKeyRole.OPERATOR,
    subscribeToPresence: ApiKeyRole.OPERATOR,
    setOnlinePresence: ApiKeyRole.OPERATOR,
    getPresence: ApiKeyRole.VIEWER,
    markChatUnread: ApiKeyRole.OPERATOR,
    clearChatMessages: ApiKeyRole.OPERATOR,
    archiveChat: ApiKeyRole.OPERATOR,
    muteChat: ApiKeyRole.OPERATOR,
    pinChat: ApiKeyRole.OPERATOR,
    deleteChat: ApiKeyRole.OPERATOR,
    sendChatState: ApiKeyRole.OPERATOR,
    getStats: OPEN,
  };

  // The role the guard resolves: the handler's own mark, else the class's.
  const rolesOf = (controller: { prototype: object }): Record<string, Role> => {
    const prototype = controller.prototype as Record<string, unknown>;
    return Object.fromEntries(
      Object.getOwnPropertyNames(prototype).flatMap(name => {
        const handler = prototype[name];
        if (typeof handler !== 'function') return [];
        // RequestMethod.GET is 0, so "is a route" is an undefined check, not a truthiness check.
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) return [];
        const role = (Reflect.getMetadata(REQUIRED_ROLE_KEY, handler) ??
          Reflect.getMetadata(REQUIRED_ROLE_KEY, controller)) as ApiKeyRole | undefined;
        return [[name, role ?? OPEN]];
      }),
    );
  };

  it.each([
    ['MessageController', MessageController, MESSAGE_ROLES],
    ['SessionController', SessionController, SESSION_ROLES],
  ])('%s carries exactly the roles in its table', (_name, controller, table) => {
    expect(rolesOf(controller)).toEqual(table);
  });
});

// The MCP invoker enforces a tool's requiredRole through hasPermission and nothing else: declaring the tool
// tier 'write' implies no role. A write tool that loses requiredRole is therefore callable over MCP by a
// read-only VIEWER key, so every write tool must declare OPERATOR or higher.
describe('MCP write tools', () => {
  // Handlers are never invoked, so stub services are fine: only the declarations are read.
  const writeTools = allAgentTools({} as never).filter(tool => tool.tier === 'write');

  it('walks the write tools (a filter that matched none would pass for the wrong reason)', () => {
    // 26 when written: session 4, message 12, contact 2, group 4, label 4.
    expect(writeTools.length).toBeGreaterThanOrEqual(26);
  });

  it('declares requiredRole OPERATOR or higher on every write tool', () => {
    expect(writeTools.filter(tool => !atLeastOperator(tool.requiredRole)).map(tool => tool.name)).toEqual([]);
  });
});
