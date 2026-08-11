import type { WASocket } from '@whiskeysockets/baileys';
import type { Client } from 'whatsapp-web.js';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { WwebjsProfile } from './wwebjs-profile';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Create-call-link — the third of the §29.5.3 "supported by BOTH libraries, missing only in OpenWA"
 * backlog, and the first where both engines hand back a value rather than a void.
 *
 * They hand back DIFFERENT values, which is the whole design problem. whatsapp-web.js resolves the
 * finished link (`https://call.whatsapp.com/video/…`, or `''` when generation failed). Baileys
 * resolves only the bare `token` attribute off the `link_create` node, and exports the two prefixes
 * separately as `CALL_VIDEO_PREFIX` / `CALL_AUDIO_PREFIX`. The interface promises one shape — the
 * finished link — so the Baileys side assembles it.
 *
 * The vocabularies differ too, and reconcile through the URL rather than by guesswork: Baileys calls
 * it `'audio'` while whatsapp-web.js calls it `'voice'`, and the audio prefix WhatsApp itself uses is
 * `/voice/`. The neutral contract says `'audio'`; each adapter maps.
 *
 * A failure must not become an empty or half-built link. `''` from whatsapp-web.js and a missing
 * token from Baileys are both "no link was generated", and a caller that received
 * `https://call.whatsapp.com/video/` with nothing after it would hand a dead link to a user.
 */

const logger = createLogger('create-call-link.spec');
const START_MS = 1_800_000_000_000; // epoch MILLISECONDS, as muteChat uses
const START_S = 1_800_000_000; // what both libraries want on the wire

describe('BaileysMessaging.createCallLink', () => {
  function makeMessaging(sock: Record<string, jest.Mock>, budgetMs = 500): BaileysMessaging {
    const host = {
      ensureReady: jest.fn(),
      getSocket: () => sock as unknown as WASocket,
      logger,
      toNeutralJid: (j: string) => j,
      toEngineJid: (j: string) => j,
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
      loadLib: () =>
        Promise.resolve({
          CALL_VIDEO_PREFIX: 'https://call.whatsapp.com/video/',
          CALL_AUDIO_PREFIX: 'https://call.whatsapp.com/voice/',
        } as never),
      getStoredMessage: () => Promise.resolve(undefined),
      putStoredMessage: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
      mapMessage: () => Promise.resolve({} as never),
    } as unknown as BaileysMessagingHost;
    return new BaileysMessaging(host, budgetMs);
  }

  it('assembles the video link from the bare token the socket returns', async () => {
    const createCallLink = jest.fn().mockResolvedValue('TOKEN123');
    const link = await makeMessaging({ createCallLink }).createCallLink('video', START_MS);

    expect(link).toBe('https://call.whatsapp.com/video/TOKEN123');
    // Baileys takes the start time in SECONDS, and its own type is 'audio' | 'video'.
    expect(createCallLink).toHaveBeenCalledWith('video', { startTime: START_S }, expect.any(Number));
  });

  it("uses WhatsApp's /voice/ prefix for an audio link", async () => {
    const createCallLink = jest.fn().mockResolvedValue('TOKEN456');
    const link = await makeMessaging({ createCallLink }).createCallLink('audio', START_MS);

    expect(link).toBe('https://call.whatsapp.com/voice/TOKEN456');
    expect(createCallLink).toHaveBeenCalledWith('audio', { startTime: START_S }, expect.any(Number));
  });

  // The failure that would otherwise be silent: a prefix with nothing after it is a dead link that
  // looks like a real one.
  it('refuses to return a prefix-only link when no token came back', async () => {
    const createCallLink = jest.fn().mockResolvedValue(undefined);
    await expect(makeMessaging({ createCallLink }).createCallLink('video', START_MS)).rejects.toThrow(
      /did not return a call link/i,
    );
  });

  it('reports an unanswered query rather than hanging on a silent socket', async () => {
    const createCallLink = jest.fn(() => new Promise<never>(() => undefined));
    await expect(makeMessaging({ createCallLink }, 15).createCallLink('video', START_MS)).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });
});

describe('WwebjsProfile.createCallLink', () => {
  function makeProfile(client: Record<string, jest.Mock>): WwebjsProfile {
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
    } as unknown as WwebjsEngineHost;
    return new WwebjsProfile(host);
  }

  it('returns the finished link the client resolves', async () => {
    const createCallLink = jest.fn().mockResolvedValue('https://call.whatsapp.com/video/TOKEN789');
    const link = await makeProfile({ createCallLink }).createCallLink('video', START_MS);

    expect(link).toBe('https://call.whatsapp.com/video/TOKEN789');
    const [startDate, callType] = createCallLink.mock.calls[0] as [Date, string];
    expect(startDate.getTime()).toBe(START_MS);
    expect(callType).toBe('video');
  });

  // whatsapp-web.js rejects anything but 'voice' | 'video', so the neutral 'audio' must be mapped.
  it("maps the neutral 'audio' onto the library's 'voice'", async () => {
    const createCallLink = jest.fn().mockResolvedValue('https://call.whatsapp.com/voice/TOKENABC');
    await makeProfile({ createCallLink }).createCallLink('audio', START_MS);

    expect((createCallLink.mock.calls[0] as [Date, string])[1]).toBe('voice');
  });

  it('treats the empty string as a failure rather than returning it', async () => {
    const createCallLink = jest.fn().mockResolvedValue('');
    await expect(makeProfile({ createCallLink }).createCallLink('video', START_MS)).rejects.toThrow(
      /did not return a call link/i,
    );
  });
});
