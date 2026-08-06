import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';

describe('TemplateController', () => {
  const service = {
    create: jest.fn(),
    findBySession: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const controller = new TemplateController(service as unknown as TemplateService);

  beforeEach(() => jest.clearAllMocks());

  it('create delegates with the session id and DTO', async () => {
    const dto = { name: 'welcome', content: 'Hi {{name}}' };
    service.create.mockResolvedValue({ id: 't1' });
    await controller.create('s1', dto as never);
    expect(service.create).toHaveBeenCalledWith('s1', dto);
  });

  it('findBySession delegates', async () => {
    service.findBySession.mockResolvedValue([]);
    await controller.findBySession('s1');
    expect(service.findBySession).toHaveBeenCalledWith('s1');
  });

  it('findOne delegates with session + id', async () => {
    service.findOne.mockResolvedValue({ id: 't1' });
    await controller.findOne('s1', 't1');
    expect(service.findOne).toHaveBeenCalledWith('s1', 't1');
  });

  it('update delegates with session, id and DTO', async () => {
    const dto = { content: 'bye' };
    service.update.mockResolvedValue({ id: 't1' });
    await controller.update('s1', 't1', dto as never);
    expect(service.update).toHaveBeenCalledWith('s1', 't1', dto);
  });

  it('delete delegates and resolves void', async () => {
    service.delete.mockResolvedValue(undefined);
    await expect(controller.delete('s1', 't1')).resolves.toBeUndefined();
    expect(service.delete).toHaveBeenCalledWith('s1', 't1');
  });
});
