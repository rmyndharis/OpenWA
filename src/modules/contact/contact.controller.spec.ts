import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

describe('ContactController', () => {
  const service = {
    getContacts: jest.fn(),
    getProfilePictures: jest.fn(),
    getContactById: jest.fn(),
    getNumberId: jest.fn(),
    getProfilePicture: jest.fn(),
    resolveContactPhone: jest.fn(),
    upsertContact: jest.fn(),
    deleteContact: jest.fn(),
    blockContact: jest.fn(),
    unblockContact: jest.fn(),
  };
  const controller = new ContactController(service as unknown as ContactService);

  beforeEach(() => jest.clearAllMocks());

  it('findAll parses limit/offset query strings', async () => {
    service.getContacts.mockResolvedValue([]);
    await controller.findAll('s1', '5', '10');
    expect(service.getContacts).toHaveBeenCalledWith('s1', { limit: 5, offset: 10 });
  });

  it('findAll leaves paging undefined without query params', async () => {
    service.getContacts.mockResolvedValue([]);
    await controller.findAll('s1');
    expect(service.getContacts).toHaveBeenCalledWith('s1', { limit: undefined, offset: undefined });
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
