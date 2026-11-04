import { NotFoundException } from '@nestjs/common';
import type { Client } from 'whatsapp-web.js';
import { WwebjsChats } from './wwebjs-chats';
import { WwebjsContacts } from './wwebjs-contacts';
import { WwebjsGroups } from './wwebjs-groups';
import { WwebjsLabels } from './wwebjs-labels';
import { type WwebjsEngineHost, withPage } from './wwebjs-host';
import { type WwebjsMessaging } from './wwebjs-messaging';
import {
  CAPTURED_PAGE_ERROR_PREFIX,
  PAGE_RELOADING_MESSAGE,
  WwebjsLifecycle,
  isNavigationError,
} from './wwebjs-lifecycle';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * A call already in flight when WhatsApp Web reloads its page dies with Puppeteer's navigation error before
 * the re-inject window is stamped, so it was a bare 500, and where a catch folds a failed lookup into "not
 * found" it was a 404 or null for a group, contact or label that exists. The page is alive: nothing is
 * reported, and the answer is the retryable 409 the adapter already gives inside the window.
 */
const logger = createLogger('wwebjs-navigation-error.spec');

const NAVIGATION = 'Execution context was destroyed, most likely because of a navigation.';

describe('isNavigationError', () => {
  it.each([
    NAVIGATION,
    'Evaluation failed: TypeError: window.require is not a function',
    'execution context was destroyed',
  ])('reads %p as a navigation', message => {
    expect(isNavigationError(new Error(message))).toBe(true);
  });

  it('is not a dead page, so the death path never sees it', () => {
    const pattern = (WwebjsLifecycle as unknown as { PAGE_TRANSPORT_ERROR_PATTERN: RegExp })
      .PAGE_TRANSPORT_ERROR_PATTERN;
    expect(pattern.test(NAVIGATION)).toBe(false);
  });

  it.each([
    'Protocol error (Runtime.callFunctionOn): Target closed',
    "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls",
    'Evaluation failed: TypeError: Cannot read properties of null',
    '',
  ])('does not read %p as a navigation', message => {
    expect(isNavigationError(new Error(message))).toBe(false);
  });

  it('does not take the words from an error this application built', () => {
    // MessageNotFoundError and its siblings carry the caller's own text, so a request could name its way in.
    expect(isNavigationError(new NotFoundException(`Message ${NAVIGATION} not found in chat 1@c.us`))).toBe(false);
  });

  it('does not take the words from a failure captured inside the page', () => {
    expect(isNavigationError(new Error(`${CAPTURED_PAGE_ERROR_PREFIX}{"message":"${NAVIGATION}"}`))).toBe(false);
  });
});

describe('a call the page navigation cut short', () => {
  const navigation = new Error(NAVIGATION);
  const ordinary = new Error('Evaluation failed: something else');

  function makeHost(client: unknown): { host: WwebjsEngineHost; reportIfPageTransportError: jest.Mock } {
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError,
      logger,
      config: {},
    } as unknown as WwebjsEngineHost;
    return { host, reportIfPageTransportError };
  }

  const reload = (): unknown => expect.objectContaining({ message: PAGE_RELOADING_MESSAGE });

  it('withPage answers the 409 and reports nothing', async () => {
    const { host, reportIfPageTransportError } = makeHost({});

    const result = withPage(host, 'getNumberId', () => Promise.reject(navigation));

    await expect(result).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(result).rejects.toEqual(reload());
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  it('a page the host reads as dead stays a death, whatever the message says', async () => {
    const { host, reportIfPageTransportError } = makeHost({});
    (host as unknown as { isPageTransportError: () => boolean }).isPageTransportError = () => true;

    await expect(withPage(host, 'getNumberId', () => Promise.reject(navigation))).rejects.toBeInstanceOf(
      EngineTransportError,
    );
    expect(reportIfPageTransportError).toHaveBeenCalledWith(navigation, 'getNumberId');
  });

  it('withPage still propagates an ordinary failure unchanged', async () => {
    const { host } = makeHost({});

    await expect(withPage(host, 'getNumberId', () => Promise.reject(ordinary))).rejects.toBe(ordinary);
  });

  it('the chat and group lists answer the 409', async () => {
    const client = { info: {}, pupPage: { evaluate: jest.fn().mockRejectedValue(navigation) } };
    const { host, reportIfPageTransportError } = makeHost(client);

    await expect(new WwebjsChats(host, {} as unknown as WwebjsMessaging).getChats()).rejects.toBeInstanceOf(
      EngineNotReadyError,
    );
    await expect(new WwebjsGroups(host).getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  it('a group read is not "group not found"', async () => {
    const getChatById = jest.fn().mockRejectedValue(navigation);
    const { host } = makeHost({ info: {}, getChatById });

    await expect(new WwebjsGroups(host).getGroupInfo('1@g.us')).rejects.toBeInstanceOf(EngineNotReadyError);

    getChatById.mockRejectedValue(ordinary);
    await expect(new WwebjsGroups(host).getGroupInfo('1@g.us')).resolves.toBeNull();
  });

  it('an invite preview is not "no such invite"', async () => {
    const getInviteInfo = jest.fn().mockRejectedValue(navigation);
    const { host } = makeHost({ getInviteInfo });

    await expect(new WwebjsGroups(host).getGroupJoinInfo('code')).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('an invite acceptance answers the unknown-outcome 503, not an invalid invite', async () => {
    const acceptInvite = jest.fn().mockRejectedValue(navigation);
    const { host } = makeHost({ acceptInvite });

    await expect(new WwebjsGroups(host).joinGroupViaInviteCode('code')).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('a contact read is not "no such contact"', async () => {
    const getContactById = jest.fn().mockRejectedValue(navigation);
    const { host } = makeHost({ getContactById });

    await expect(new WwebjsContacts(host).getContactById('1@c.us')).rejects.toBeInstanceOf(EngineNotReadyError);

    getContactById.mockRejectedValue(ordinary);
    await expect(new WwebjsContacts(host).getContactById('1@c.us')).resolves.toBeNull();
  });

  it('the contact list, the avatar and the number lookup answer the 409', async () => {
    const getProfilePicUrl = jest.fn().mockRejectedValue(navigation);
    const getNumberId = jest.fn().mockRejectedValue(navigation);
    const client = {
      info: {},
      pupPage: { evaluate: jest.fn().mockRejectedValue(navigation) },
      getProfilePicUrl,
      getNumberId,
    };
    const { host, reportIfPageTransportError } = makeHost(client);
    const contacts = new WwebjsContacts(host);

    await expect(contacts.getContacts()).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(contacts.getProfilePicture('1@c.us')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(contacts.getNumberId('628123')).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  it('a chat write answers the 409', async () => {
    const getChatById = jest.fn().mockRejectedValue(navigation);
    const { host } = makeHost({ getChatById });

    await expect(
      new WwebjsChats(host, {} as unknown as WwebjsMessaging).muteChat('1@c.us', null),
    ).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('a label read is not "no such label"', async () => {
    const getChatsByLabelId = jest.fn().mockRejectedValue(navigation);
    const { host } = makeHost({ getChatsByLabelId });

    await expect(new WwebjsLabels(host).getChatsByLabel('7')).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});
