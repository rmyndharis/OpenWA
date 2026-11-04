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
    });

    try {
      // No transaction of its own: on SQLite's single shared connection the rollback of the unique
      // violation handled below would also discard what other callers wrote while it was open.
      const saved = await this.templateRepository.save(template, { transaction: false });
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
    // PostgreSQL rejects a NUL in a bound text parameter (a 500), and ids are server-generated uuids, so
    // none can match: answer 404 without querying. Covers the :id routes and resolve() by id.
    const template = id.includes('\u0000') ? null : await this.templateRepository.findOne({ where: { id, sessionId } });
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
      // PostgreSQL rejects a NUL in a bound text parameter (a 500), and the write DTOs refuse one, so no
      // stored name can match: answer 404 without querying.
      if (templateName.includes('\u0000')) {
        throw new NotFoundException(`Template with name '${templateName}' not found`);
      }
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

    const patch: Partial<Pick<Template, 'name' | 'body' | 'header' | 'footer'>> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.body !== undefined) patch.body = dto.body;
    if (dto.header !== undefined) patch.header = dto.header;
    if (dto.footer !== undefined) patch.footer = dto.footer;
    if (Object.keys(patch).length === 0) return template;

    try {
      // Update only supplied fields, and never reinsert a concurrently deleted template.
      const result = await this.templateRepository.update({ id, sessionId }, patch);
      if (!result.affected) throw new NotFoundException(`Template with id '${id}' not found`);
      return await this.findOne(sessionId, id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A template named '${dto.name ?? template.name}' already exists for this session`);
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
