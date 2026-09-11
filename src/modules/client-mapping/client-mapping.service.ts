import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { resolveSessionScope } from '../../common/security/session-scope';
import { userPart } from '../../engine/identity/wa-id';
import { ClientMapping } from './entities/client-mapping.entity';
import type { ClientMappingKind } from './entities/client-mapping.entity';
import { ClientMappingIdentityService } from './client-mapping-identity.service';
import { UNKNOWN_CLIENT_MAPPING_COMPANY } from './client-mapping.constants';
import {
  CreateClientMappingDto,
  ResolveAndUpsertClientMappingDto,
  UpdateClientMappingDto,
} from './dto/client-mapping.dto';

export interface ClientMappingFilter {
  sessionId?: string;
  kind?: ClientMappingKind;
  company?: string;
}

export interface ResolveAndUpsertResult {
  mapping: ClientMapping;
  created: boolean;
}

@Injectable()
export class ClientMappingService {
  constructor(
    @InjectRepository(ClientMapping, 'data') private readonly repo: Repository<ClientMapping>,
    private readonly identity: ClientMappingIdentityService,
  ) {}

  async create(dto: CreateClientMappingDto): Promise<ClientMapping> {
    if (dto.kind === 'teammate') {
      if (dto.sessionId) {
        throw new BadRequestException(
          'sessionId must not be set for kind=teammate (teammates have no WhatsApp session)',
        );
      }
      // The DB unique index cannot catch this: sessionId is NULL for every teammate row, and both
      // Postgres and SQLite treat NULLs as distinct in a unique index, so two teammate rows with the
      // same jid would not collide there. See the entity's doc comment for the full reasoning.
      const existing = await this.repo.findOne({ where: { kind: 'teammate', jid: dto.jid } });
      if (existing) {
        throw new ConflictException(`Teammate mapping for jid "${dto.jid}" already exists`);
      }
    } else if (!dto.sessionId) {
      throw new BadRequestException(
        `sessionId is required for kind=${dto.kind} (a jid is only unique within a session)`,
      );
    }

    if (dto.backupOwnerId) {
      await this.assertValidBackupOwner(dto.backupOwnerId, null);
    }

    const mapping = this.repo.create({
      sessionId: dto.sessionId ?? null,
      jid: dto.jid,
      kind: dto.kind,
      name: dto.name,
      phone: dto.phone ?? null,
      company: dto.company,
      team: dto.team ?? null,
      role: dto.role ?? null,
      timezone: dto.timezone ?? null,
      status: dto.status ?? 'active',
      backupOwnerId: dto.backupOwnerId ?? null,
      sentimentTracking: dto.sentimentTracking ?? true,
      notes: dto.notes ?? null,
    });

    try {
      return await this.repo.save(mapping);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A ${dto.kind} mapping for jid "${dto.jid}" already exists` +
            (dto.sessionId ? ` in session "${dto.sessionId}"` : ''),
        );
      }
      throw err;
    }
  }

  /**
   * `allowedSessions` is currently always null/empty by the time this is called — the controller
   * is gated `@RequireUnscopedKey()`, and the guard rejects any key with a non-empty allowlist
   * before the handler runs. It is threaded through anyway (the `resolveSessionScope` pattern used
   * by audit/webhooks-list/search) so this stays correct if that gate is ever loosened, rather than
   * silently becoming a cross-tenant leak the day it is.
   */
  findAll(filter: ClientMappingFilter = {}, allowedSessions?: string[] | null): Promise<ClientMapping[]> {
    const where: FindOptionsWhere<ClientMapping> = {};
    const sessionScope = resolveSessionScope(allowedSessions, filter.sessionId);
    if (sessionScope !== null) {
      if (sessionScope.length === 0) return Promise.resolve([]);
      where.sessionId = In(sessionScope);
    }
    if (filter.kind !== undefined) where.kind = filter.kind;
    if (filter.company !== undefined) where.company = filter.company;
    return this.repo.find({ where, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async findOne(id: string): Promise<ClientMapping> {
    const mapping = await this.repo.findOne({ where: { id } });
    if (!mapping) {
      throw new NotFoundException(`Client mapping ${id} not found`);
    }
    return mapping;
  }

  async update(id: string, dto: UpdateClientMappingDto): Promise<ClientMapping> {
    const mapping = await this.findOne(id);

    if (dto.backupOwnerId !== undefined && dto.backupOwnerId !== null) {
      await this.assertValidBackupOwner(dto.backupOwnerId, id);
    }

    if (dto.name !== undefined) mapping.name = dto.name;
    if (dto.phone !== undefined) mapping.phone = dto.phone;
    if (dto.company !== undefined) mapping.company = dto.company;
    if (dto.team !== undefined) mapping.team = dto.team;
    if (dto.role !== undefined) mapping.role = dto.role;
    if (dto.timezone !== undefined) mapping.timezone = dto.timezone;
    if (dto.status !== undefined) mapping.status = dto.status;
    if (dto.backupOwnerId !== undefined) mapping.backupOwnerId = dto.backupOwnerId;
    if (dto.sentimentTracking !== undefined) mapping.sentimentTracking = dto.sentimentTracking;
    if (dto.notes !== undefined) mapping.notes = dto.notes;

    return this.repo.save(mapping);
  }

  async remove(id: string): Promise<void> {
    const mapping = await this.findOne(id);
    await this.repo.remove(mapping);
  }

  /**
   * The one path every automatic writer (auto-tag, "Import from Chats") calls instead of deciding
   * "does this exist" and resolving identity itself (docs/32 §5). Dedupes a contact by resolved
   * PHONE first, not raw jid — the fix for the case where the same real contact's `@lid`
   * group-participant id and `@c.us` 1:1-chat id were treated as two different people because each
   * caller only ever checked its own raw jid.
   */
  async resolveAndUpsert(dto: ResolveAndUpsertClientMappingDto): Promise<ResolveAndUpsertResult> {
    const phone =
      dto.phoneHint !== undefined
        ? (dto.phoneHint ?? null)
        : dto.kind === 'contact'
          ? await this.identity.resolvePhone(dto.sessionId, dto.jid)
          : null;

    if (dto.kind === 'contact' && phone) {
      const byPhone = await this.repo.findOne({ where: { sessionId: dto.sessionId, kind: 'contact', phone } });
      if (byPhone) return { mapping: await this.rememberAlias(byPhone, dto.jid), created: false };
    }

    const existing = await this.repo.findOne({ where: { sessionId: dto.sessionId, jid: dto.jid, kind: dto.kind } });
    if (existing) return { mapping: existing, created: false };

    const mapping = this.repo.create({
      sessionId: dto.sessionId,
      jid: dto.jid,
      kind: dto.kind,
      name: dto.nameHint?.trim() || userPart(dto.jid),
      phone,
      company: dto.company?.trim() || UNKNOWN_CLIENT_MAPPING_COMPANY,
      team: null,
      role: null,
      timezone: null,
      status: 'active',
      backupOwnerId: null,
      sentimentTracking: true,
      notes: null,
    });

    try {
      return { mapping: await this.repo.save(mapping), created: true };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost a create race against another caller for the same (sessionId, jid, kind) — e.g. two
        // groups sharing this participant were imported concurrently. The winner's row is the
        // correct answer either way.
        const winner = await this.repo.findOne({ where: { sessionId: dto.sessionId, jid: dto.jid, kind: dto.kind } });
        if (winner) return { mapping: winner, created: false };
      }
      throw err;
    }
  }

  /**
   * Called whenever resolveAndUpsert matches an incoming jid to an existing row by PHONE rather
   * than by its own `jid` column — the incoming jid would otherwise be silently discarded instead
   * of ever being recorded anywhere. `jid` itself is never touched (every other part of the app
   * already reads/writes through it); this only grows `aliasJids`, and only when the incoming jid
   * isn't already in it, so a hot path (the same @lid seen on every message in a group) doesn't
   * write on every call.
   */
  private async rememberAlias(mapping: ClientMapping, jid: string): Promise<ClientMapping> {
    if (mapping.jid === jid) return mapping;
    const existing = this.parseAliasJids(mapping.aliasJids);
    if (existing.includes(jid)) return mapping;
    mapping.aliasJids = JSON.stringify([...existing, jid]);
    return this.repo.save(mapping);
  }

  private parseAliasJids(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  /** backupOwnerId is not a DB foreign key (see entity doc comment), so existence and self-reference are checked here. */
  private async assertValidBackupOwner(backupOwnerId: string, selfId: string | null): Promise<void> {
    if (backupOwnerId === selfId) {
      throw new BadRequestException('backupOwnerId cannot reference itself');
    }
    const owner = await this.repo.findOne({ where: { id: backupOwnerId } });
    if (!owner) {
      throw new BadRequestException(`backupOwnerId "${backupOwnerId}" does not reference an existing mapping`);
    }
  }
}
