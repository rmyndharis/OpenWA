import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysGroups, BaileysGroupsHost } from './baileys-groups';
import { BaileysChannels, BaileysChannelsHost } from './baileys-channels';
import { BaileysCatalog, BaileysCatalogHost } from './baileys-catalog';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * A Baileys call fails one of two ways when the connection closes under it: a query still waiting rejects with
 * the WebSocket's close code, a bare number, and a write on a socket that is no longer open throws
 * `Boom('Connection Closed', 428)`. Neither is a WhatsApp answer, and both reached the client as a bare 500.
 */
const closures: Array<[string, () => unknown]> = [
  ['the close code a waiting query rejects with', () => 1006],
  ['the refusal of a write on a closed socket', () => new Boom('Connection Closed', { statusCode: 428 })],
];

const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };

function groups(sock: Record<string, jest.Mock>): BaileysGroups {
  const host = {
    ensureReady: () => undefined,
    sessionProxyUrl: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    logger,
    toNeutralJid: (j: string) => j,
    toEngineJid: (j: string) => j,
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    addLidMappings: jest.fn(),
  } as unknown as BaileysGroupsHost;
  return new BaileysGroups(host, 500);
}

function channels(sock: Record<string, jest.Mock>): BaileysChannels {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    toEngineJid: (j: string) => j,
  } as unknown as BaileysChannelsHost;
  return new BaileysChannels(host, 500);
}

function catalog(sock: Record<string, jest.Mock>): BaileysCatalog {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    logger,
  } as unknown as BaileysCatalogHost;
  return new BaileysCatalog(host, 500);
}

const G = '120363000000000000@g.us';
const C = '120363@newsletter';

const calls: Array<[string, (fail: jest.Mock) => Promise<unknown>]> = [
  ['the member label', fail => groups({ updateMemberLabel: fail }).setGroupMemberLabel(G, 'A')],
  ['the group subject', fail => groups({ groupUpdateSubject: fail }).setGroupSubject(G, 'S')],
  ['a participant removal', fail => groups({ groupParticipantsUpdate: fail }).removeParticipants(G, ['628111@c.us'])],
  ['the invite code read', fail => groups({ groupInviteCode: fail }).getGroupInviteCode(G)],
  ['the group picture removal', fail => groups({ removeProfilePicture: fail }).deleteGroupPicture(G)],
  ['the group list', fail => groups({ groupFetchAllParticipating: fail }).getGroups()],
  ['the group read', fail => groups({ groupMetadata: fail }).getGroupInfo(G)],
  ['the invite preview', fail => groups({ groupGetInviteInfo: fail }).getGroupJoinInfo('CODE')],
  ['the group join', fail => groups({ groupAcceptInvite: fail }).joinGroupViaInviteCode('CODE')],
  ['the channel read', fail => channels({ newsletterMetadata: fail }).getChannelById(C)],
  ['the channel delete', fail => channels({ newsletterDelete: fail }).deleteChannel(C)],
  ['the catalog read', fail => catalog({ getCatalog: fail }).getProducts()],
];

describe.each(closures)('A connection that closes with %s', (_shape, closed) => {
  it.each(calls)('answers %s with a retryable 503, not a bare 500', async (_name, call) => {
    await expect(call(jest.fn().mockRejectedValue(closed()))).rejects.toBeInstanceOf(EngineTransportError);
  });

  // A create is the one write a retry could repeat: a closed connection does not say whether it was applied.
  it('leaves a group or channel create as opaque as its timeout', async () => {
    const error = closed();
    await expect(groups({ groupCreate: jest.fn().mockRejectedValue(error) }).createGroup('G', [])).rejects.toBe(error);
    await expect(channels({ newsletterCreate: jest.fn().mockRejectedValue(error) }).createChannel('C')).rejects.toBe(
      error,
    );
  });
});

it('keeps a WhatsApp answer that carries code 428 the refusal it is', async () => {
  const iqAnswer = new Boom('precondition-required', { data: 428 });
  await expect(
    groups({ groupUpdateSubject: jest.fn().mockRejectedValue(iqAnswer) }).setGroupSubject(G, 'S'),
  ).rejects.toBeInstanceOf(EngineRefusedError);
  const graphQlAnswer = new Boom('GraphQL server error: precondition', {
    statusCode: 428,
    data: { message: 'precondition', extensions: { error_code: 428 } },
  });
  await expect(
    channels({ newsletterDelete: jest.fn().mockRejectedValue(graphQlAnswer) }).deleteChannel(C),
  ).rejects.toBeInstanceOf(EngineRefusedError);
});
