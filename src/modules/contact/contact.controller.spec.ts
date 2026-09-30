import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { ChatScopeService } from '../auth/chat-scope.service';
import type { ApiKey } from '../auth/entities/api-key.entity';

describe('ContactController', () => {
  const service = {
    listContacts: jest.fn(),
    getProfilePictures: jest.fn(),
    getContactById: jest.fn(),
    getNumberId: jest.fn(),
    getProfilePicture: jest.fn(),
    resolveContactPhone: jest.fn(),
    upsertContact: jest.fn(),
    deleteContact: jest.fn(),
    blockContact: jest.fn(),
    unblockContact: jest.fn(),
    getBlockedContacts: jest.fn(),
  };
  const controller = new ContactController(service as unknown as ContactService, new ChatScopeService());

  beforeEach(() => jest.clearAllMocks());

  const contacts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}@c.us` }));

  it('findAll applies limit/offset query strings', async () => {
    service.listContacts.mockResolvedValue(contacts(50));
    const page = (await controller.findAll('s1', '5', '10')) as { id: string }[];
    expect(service.listContacts).toHaveBeenCalledWith('s1');
    expect(page.map(c => c.id)).toEqual(['10@c.us', '11@c.us', '12@c.us', '13@c.us', '14@c.us']);
  });

  it('findAll caps an unpaged list at the default window', async () => {
    service.listContacts.mockResolvedValue(contacts(1500));
    await expect(controller.findAll('s1')).resolves.toHaveLength(1000);
  });

  it('findAll filters to a chat-restricted key before the window, matching either phone dialect', async () => {
    // The disallowed contact comes first, so a page of 1 taken before filtering would hold nothing allowed.
    service.listContacts.mockResolvedValue([
      { id: '999@c.us' },
      { id: '62811@s.whatsapp.net' },
      { id: '62811@c.us' },
      { id: '555000111@lid' },
    ]);
    const apiKey = { allowedChats: ['62811@c.us'] } as ApiKey;

    const all = (await controller.findAll('s1', undefined, undefined, apiKey)) as { id: string }[];
    expect(all.map(c => c.id)).toEqual(['62811@s.whatsapp.net', '62811@c.us']);
    const first = (await controller.findAll('s1', '1', '0', apiKey)) as { id: string }[];
    expect(first.map(c => c.id)).toEqual(['62811@s.whatsapp.net']);
  });

  it('getProfilePictures splits, trims and drops empty ids', async () => {
    service.getProfilePictures.mockResolvedValue([null, 'https://pps/2.jpg']);
    const out = await controller.getProfilePictures('s1', ' a@c.us , ,b@c.us ');
    expect(service.getProfilePictures).toHaveBeenCalledWith('s1', ['a@c.us', 'b@c.us']);
    expect(out).toEqual({ pictures: [null, 'https://pps/2.jpg'] });
  });

  it('getProfilePictures defaults a missing ids param to an empty list', async () => {
    service.getProfilePictures.mockResolvedValue([]);
    await controller.getProfilePictures('s1');
    expect(service.getProfilePictures).toHaveBeenCalledWith('s1', []);
  });

  it('findOne delegates to the service', async () => {
    service.getContactById.mockResolvedValue({ id: 'c1' });
    await controller.findOne('s1', 'c1');
    expect(service.getContactById).toHaveBeenCalledWith('s1', 'c1');
  });

  it('checkNumber maps a null whatsappId to exists:false', async () => {
    service.getNumberId.mockResolvedValue(null);
    await expect(controller.checkNumber('s1', '628123')).resolves.toEqual({
      number: '628123',
      exists: false,
      whatsappId: null,
    });
  });

  it('checkNumber returns the canonical id when the number exists', async () => {
    service.getNumberId.mockResolvedValue('628123@c.us');
    await expect(controller.checkNumber('s1', '628123')).resolves.toEqual({
      number: '628123',
      exists: true,
      whatsappId: '628123@c.us',
    });
  });

  it('getProfilePicture wraps the url', async () => {
    service.getProfilePicture.mockResolvedValue('https://pps/1.jpg');
    await expect(controller.getProfilePicture('s1', 'c1')).resolves.toEqual({ url: 'https://pps/1.jpg' });
  });

  it('resolvePhone wraps contactId and phone', async () => {
    service.resolveContactPhone.mockResolvedValue('628123456789');
    await expect(controller.resolvePhone('s1', '123@lid')).resolves.toEqual({
      contactId: '123@lid',
      phone: '628123456789',
    });
  });

  it('getBlockedContacts returns the service list as a bare array', async () => {
    service.getBlockedContacts.mockResolvedValue(['628111@c.us', '628222@c.us']);
    await expect(controller.getBlockedContacts('s1')).resolves.toEqual(['628111@c.us', '628222@c.us']);
    expect(service.getBlockedContacts).toHaveBeenCalledWith('s1');
  });

  it('upsertContact passes first/last name from the DTO', async () => {
    service.upsertContact.mockResolvedValue(undefined);
    await expect(controller.upsertContact('s1', 'c1', { firstName: 'A', lastName: 'B' })).resolves.toEqual({
      success: true,
      message: 'Contact saved',
    });
    expect(service.upsertContact).toHaveBeenCalledWith('s1', 'c1', 'A', 'B');
  });

  it.each([
    ['deleteContact', { success: true, message: 'Contact deleted' }],
    ['blockContact', { success: true, message: 'Contact blocked' }],
    ['unblockContact', { success: true, message: 'Contact unblocked' }],
  ] as const)('%s delegates and returns its success body', async (method, body) => {
    service[method].mockResolvedValue(undefined);
    await expect(controller[method]('s1', 'c1')).resolves.toEqual(body);
    expect(service[method]).toHaveBeenCalledWith('s1', 'c1');
  });
});
