import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template } from './entities/template.entity';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueConstraintError } from '../../common/utils/unique-constraint.util';

@Injectable()
export class TemplateService {
  private readonly logger = createLogger('TemplateService');

  constructor(
    @InjectRepository(Template, 'data')
    private readonly templateRepository: Repository<Template>,
  ) {}

  async create(sessionId: string, dto: CreateTemplateDto): Promise<Template> {
    const template = this.templateRepository.create({
      sessionId,
      name: dto.name,
      body: dto.body,
      header: dto.header ?? null,
      footer: dto.footer ?? null,
    });

    try {
      const saved = await this.templateRepository.save(template);
      this.logger.log('Template created', { sessionId, templateId: saved.id, name: saved.name });
      return saved;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException(`A template named '${dto.name}' already exists for this session`);
      }
      throw err;
    }
  }

  async findBySession(sessionId: string): Promise<Template[]> {
    return this.templateRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(sessionId: string, id: string): Promise<Template> {
    const template = await this.templateRepository.findOne({ where: { id, sessionId } });
    if (!template) {
      throw new NotFoundException(`Template with id '${id}' not found`);
    }
    return template;
  }

  /**
   * Resolve a template for a session by id or by name. Throws NotFoundException
   * when neither identifier matches. Used by the send-template message flow.
   */
  async resolve(sessionId: string, identifier: { templateId?: string; templateName?: string }): Promise<Template> {
    const { templateId, templateName } = identifier;

    if (templateId) {
      return this.findOne(sessionId, templateId);
    }

    if (templateName) {
      // Order by createdAt ASC so resolution is deterministic if more than one row shares a name
      // (possible only on a DB predating the unique index); the migration keeps the earliest too.
      const template = await this.templateRepository.findOne({
        where: { name: templateName, sessionId },
        order: { createdAt: 'ASC' },
      });
      if (!template) {
        throw new NotFoundException(`Template with name '${templateName}' not found`);
      }
      return template;
    }

    throw new NotFoundException('Either templateId or templateName must be provided');
  }

  async update(sessionId: string, id: string, dto: UpdateTemplateDto): Promise<Template> {
    const template = await this.findOne(sessionId, id);

    if (dto.name !== undefined) template.name = dto.name;
    if (dto.body !== undefined) template.body = dto.body;
    if (dto.header !== undefined) template.header = dto.header;
    if (dto.footer !== undefined) template.footer = dto.footer;

    try {
      return await this.templateRepository.save(template);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException(`A template named '${template.name}' already exists for this session`);
      }
      throw err;
    }
  }

  async delete(sessionId: string, id: string): Promise<void> {
    const template = await this.findOne(sessionId, id);
    await this.templateRepository.remove(template);
    this.logger.log('Template deleted', { sessionId, templateId: id });
  }
}
