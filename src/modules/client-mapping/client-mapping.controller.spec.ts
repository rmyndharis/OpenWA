import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientMappingController } from './client-mapping.controller';
import type { ClientMappingService } from './client-mapping.service';
import type { ClientMapping } from './entities/client-mapping.entity';
import type { ApiKey } from '../auth/entities/api-key.entity';

/**
 * The controller is a thin map from query/route params/DTOs onto ClientMappingService, plus the
 * entity->response projection. Worth pinning: which argument lands in which slot, that responses
 * expose only the DTO fields, and that service rejections reach the caller unmapped.
 */
function mappingEntity(overrides: Partial<ClientMapping> = {}): ClientMapping {
  return {
    id: 'map-1',
    sessionId: 's1',
    jid: '628111@c.us',
    kind: 'contact',
    name: 'Alice',
    phone: null,
    company: 'Acme',
    team: null,
    role: null,
    timezone: null,
    status: 'active',
    backupOwnerId: null,
    sentimentTracking: true,
    notes: null,
    aliasJids: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ClientMappingController', () => {
  const service = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const controller = new ClientMappingController(service as unknown as ClientMappingService);

  beforeEach(() => jest.clearAllMocks());

  it('create delegates to the service and projects the entity onto the response DTO', async () => {
    const dto = { jid: '628222@c.us', kind: 'contact' as const, name: 'Bob', company: 'Acme', sessionId: 's1' };
    service.create.mockResolvedValue(mappingEntity());

    const result = await controller.create(dto);

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result.id).toBe('map-1');
    expect(result.company).toBe('Acme');
  });

  it("findAll forwards all three filters plus the calling key's allowedSessions, and projects every mapping", async () => {
    service.findAll.mockResolvedValue([mappingEntity(), mappingEntity({ id: 'map-2', kind: 'group' })]);
    const apiKey = { allowedSessions: null } as unknown as ApiKey;

    const result = await controller.findAll(apiKey, 's1', 'contact', 'Acme');

    expect(service.findAll).toHaveBeenCalledWith({ sessionId: 's1', kind: 'contact', company: 'Acme' }, null);
    expect(result.map(m => m.id)).toEqual(['map-1', 'map-2']);
  });

  it('findOne forwards the id', async () => {
    service.findOne.mockResolvedValue(mappingEntity());

    const result = await controller.findOne('map-1');

    expect(service.findOne).toHaveBeenCalledWith('map-1');
    expect(result.id).toBe('map-1');
  });

  it('update forwards the id and DTO', async () => {
    const dto = { team: 'Design' };
    service.update.mockResolvedValue(mappingEntity({ team: 'Design' }));

    const result = await controller.update('map-1', dto);

    expect(service.update).toHaveBeenCalledWith('map-1', dto);
    expect(result.team).toBe('Design');
  });

  it('remove forwards the id and resolves without a body', async () => {
    service.remove.mockResolvedValue(undefined);

    await expect(controller.remove('map-1')).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith('map-1');
  });

  it('create propagates invalid-mapping rejections unmapped', async () => {
    const error = new BadRequestException('sessionId is required for kind=contact');
    service.create.mockRejectedValue(error);

    await expect(
      controller.create({ jid: '628@c.us', kind: 'contact' as const, name: 'X', company: 'Acme' }),
    ).rejects.toBe(error);
  });

  it('findOne propagates not-found rejections unmapped', async () => {
    const error = new NotFoundException('Client mapping map-404 not found');
    service.findOne.mockRejectedValue(error);

    await expect(controller.findOne('map-404')).rejects.toBe(error);
  });
});
