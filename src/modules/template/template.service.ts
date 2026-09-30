import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template } from './entities/template.entity';
import { Session } from '../session/entities/session.entity';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueViolation } from '../../common/utils/db-errors';

@Injectable()
export class TemplateService {
  private readonly logger = createLogger('TemplateService');

  constructor(
    @InjectRepository(Template, 'data')
    private readonly templateRepository: Repository<Template>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
  ) {}

  async create(sessionId: string, dto: CreateTemplateDto): Promise<Template> {
    // The templates.sessionId FK turns a missing session into a driver error (500) at save time;
    // check first so the caller gets a truthful 404.
    if (!(await this.sessionRepository.exists({ where: { id: sessionId } }))) {
      throw new NotFoundException(`Session with id '${sessionId}' not found`);
    }
    const template = this.templateRepository.create({
      sessionId,
      name: dto.name,
      body: dto.body,
      header: dto.header ?? null,
      footer: dto.footer ?? null,
      type: dto.type ?? 'text',
      mediaUrl: dto.mediaUrl ?? null,
    });

    try {
      const saved = await this.templateRepository.save(template);
      this.logger.log('Template created', { sessionId, templateId: saved.id, name: saved.name });
      return saved;
    } catch (err) {
      if (isUniqueViolation(err)) {
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
   * Resolve a template for a session by id or by name. Throws NotFoundException when the identifier
   * matches nothing, BadRequestException when neither is given. Used by the send-template message flow.
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

    throw new BadRequestException('Either templateId or templateName must be provided');
  }

  async update(sessionId: string, id: string, dto: UpdateTemplateDto): Promise<Template> {
    const template = await this.findOne(sessionId, id);

    if (dto.name !== undefined) template.name = dto.name;
    if (dto.body !== undefined) template.body = dto.body;
    if (dto.header !== undefined) template.header = dto.header;
    if (dto.footer !== undefined) template.footer = dto.footer;
    if (dto.type !== undefined) template.type = dto.type;
    if (dto.mediaUrl !== undefined) template.mediaUrl = dto.mediaUrl;

    try {
      return await this.templateRepository.save(template);
    } catch (err) {
      if (isUniqueViolation(err)) {
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
