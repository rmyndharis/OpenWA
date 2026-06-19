import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TemplateService } from './template.service';
import { Template } from './entities/template.entity';
import { Session } from '../session/entities/session.entity';
import { renderTemplate } from '../../common/utils/template-render';

function createMockTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 'tpl-uuid-1',
    sessionId: 'sess-1',
    name: 'order-confirmation',
    body: 'Hi {{customer}}, order {{orderId}} shipped.',
    header: null,
    footer: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    session: undefined as unknown as Session,
    ...overrides,
  };
}

describe('TemplateService', () => {
  let service: TemplateService;
  let repository: jest.Mocked<Partial<Repository<Template>>>;

  beforeEach(async () => {
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((data: Partial<Template>) => ({ id: 'tpl-uuid-1', ...data }) as Template),
      save: jest.fn().mockImplementation((tpl: Template) => Promise.resolve(tpl)),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TemplateService, { provide: getRepositoryToken(Template, 'data'), useValue: repository }],
    }).compile();

    service = module.get<TemplateService>(TemplateService);
  });

  // ── create ────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a template with normalized null header/footer', async () => {
      await service.create('sess-1', { name: 'welcome', body: 'Hi {{name}}' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          name: 'welcome',
          body: 'Hi {{name}}',
          header: null,
          footer: null,
        }),
      );
      expect(repository.save).toHaveBeenCalled();
    });

    it('should persist optional header and footer when provided', async () => {
      await service.create('sess-1', {
        name: 'promo',
        body: 'Buy now',
        header: 'OpenWA Store',
        footer: 'Reply STOP to opt out',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ header: 'OpenWA Store', footer: 'Reply STOP to opt out' }),
      );
    });
  });

  // ── findBySession ─────────────────────────────────────────────────

  describe('findBySession', () => {
    it('should list templates for a session ordered by createdAt DESC', async () => {
      (repository.find as jest.Mock).mockResolvedValue([createMockTemplate()]);

      const result = await service.findBySession('sess-1');

      expect(repository.find).toHaveBeenCalledWith({ where: { sessionId: 'sess-1' }, order: { createdAt: 'DESC' } });
      expect(result).toHaveLength(1);
    });
  });

  // ── findOne ───────────────────────────────────────────────────────

  describe('findOne', () => {
    it('should return a template scoped to the session', async () => {
      const template = createMockTemplate();
      (repository.findOne as jest.Mock).mockResolvedValue(template);

      const result = await service.findOne('sess-1', 'tpl-uuid-1');

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'tpl-uuid-1', sessionId: 'sess-1' } });
      expect(result).toBe(template);
    });

    it('should throw NotFoundException when the template does not exist', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('sess-1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── resolve ───────────────────────────────────────────────────────

  describe('resolve', () => {
    it('should resolve by templateId', async () => {
      const template = createMockTemplate();
      (repository.findOne as jest.Mock).mockResolvedValue(template);

      const result = await service.resolve('sess-1', { templateId: 'tpl-uuid-1' });

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'tpl-uuid-1', sessionId: 'sess-1' } });
      expect(result).toBe(template);
    });

    it('should resolve by templateName deterministically (earliest first)', async () => {
      const template = createMockTemplate();
      (repository.findOne as jest.Mock).mockResolvedValue(template);

      const result = await service.resolve('sess-1', { templateName: 'order-confirmation' });

      // Order by createdAt ASC so resolve-by-name is deterministic even before the unique index is
      // enforced (and after, there is only one row anyway).
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { name: 'order-confirmation', sessionId: 'sess-1' },
        order: { createdAt: 'ASC' },
      });
      expect(result).toBe(template);
    });

    it('should throw NotFoundException when name does not resolve', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.resolve('sess-1', { templateName: 'nope' })).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when neither id nor name is provided', async () => {
      await expect(service.resolve('sess-1', {})).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ────────────────────────────────────────────────────────

  describe('update', () => {
    it('should update only the provided fields', async () => {
      const template = createMockTemplate();
      (repository.findOne as jest.Mock).mockResolvedValue(template);

      await service.update('sess-1', 'tpl-uuid-1', { body: 'Updated body' });

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Updated body', name: template.name }),
      );
    });

    it('should throw NotFoundException for an unknown template', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.update('sess-1', 'missing', { body: 'x' })).rejects.toThrow(NotFoundException);
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should remove an existing template', async () => {
      const template = createMockTemplate();
      (repository.findOne as jest.Mock).mockResolvedValue(template);

      await service.delete('sess-1', 'tpl-uuid-1');

      expect(repository.remove).toHaveBeenCalledWith(template);
    });

    it('should throw NotFoundException when deleting a missing template', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.delete('sess-1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── name uniqueness (one name per session) ────────────────────────

  describe('name uniqueness', () => {
    const uniqueViolation = (): Error =>
      Object.assign(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: templates.sessionId, templates.name'), {
        code: 'SQLITE_CONSTRAINT',
      });

    it('translates a duplicate-name violation on create into 409 Conflict', async () => {
      (repository.save as jest.Mock).mockRejectedValueOnce(uniqueViolation());
      await expect(service.create('sess-1', { name: 'dup', body: 'x' })).rejects.toThrow(ConflictException);
    });

    it('translates a duplicate-name violation on update into 409 Conflict', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockTemplate());
      (repository.save as jest.Mock).mockRejectedValueOnce(uniqueViolation());
      await expect(service.update('sess-1', 'tpl-uuid-1', { name: 'dup' })).rejects.toThrow(ConflictException);
    });

    it('rethrows a non-uniqueness DB error unchanged', async () => {
      (repository.save as jest.Mock).mockRejectedValueOnce(new Error('disk I/O error'));
      await expect(service.create('sess-1', { name: 'x', body: 'y' })).rejects.toThrow('disk I/O error');
    });
  });
});

// ── renderTemplate (shared utility) ───────────────────────────────────

describe('renderTemplate', () => {
  it('should substitute known {{key}} placeholders', () => {
    const result = renderTemplate('Hi {{name}}, your code is {{code}}.', { name: 'Alice', code: '1234' });
    expect(result).toBe('Hi Alice, your code is 1234.');
  });

  it('should leave unmatched placeholders literal', () => {
    const result = renderTemplate('Hi {{name}}, ref {{missing}}.', { name: 'Bob' });
    expect(result).toBe('Hi Bob, ref {{missing}}.');
  });

  it('should tolerate surrounding whitespace inside the braces', () => {
    const result = renderTemplate('Hello {{ name }}', { name: 'Carol' });
    expect(result).toBe('Hello Carol');
  });

  it('should default to an empty vars map and leave all placeholders literal', () => {
    expect(renderTemplate('Order {{id}}')).toBe('Order {{id}}');
  });

  it('should treat a null variable value as missing (left literal)', () => {
    const result = renderTemplate('Hi {{name}}', { name: null as unknown as string });
    expect(result).toBe('Hi {{name}}');
  });

  it('should coerce non-string values to string', () => {
    const result = renderTemplate('Count: {{n}}', { n: 7 as unknown as string });
    expect(result).toBe('Count: 7');
  });

  it('should render a body at the maximum supported length without truncation', () => {
    // The DTO caps body length at 4096; the renderer itself imposes no cap and
    // must return content of the same magnitude when no placeholders are present.
    const body = 'x'.repeat(4096);
    expect(renderTemplate(body, {})).toHaveLength(4096);
  });
});
