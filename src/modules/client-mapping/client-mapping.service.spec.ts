import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { ClientMappingService } from './client-mapping.service';
import { ClientMappingIdentityService } from './client-mapping-identity.service';
import { ClientMapping } from './entities/client-mapping.entity';

describe('ClientMappingService', () => {
  let ds: DataSource;
  let service: ClientMappingService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ClientMapping],
      synchronize: true,
    });
    await ds.initialize();
    // Real EngineRegistry, not a mock (same pattern as message-projector.service.spec.ts) — with no
    // engine registered for any session, resolvePhone always answers null, which is exactly the
    // "can't resolve" case these tests want as their baseline.
    service = new ClientMappingService(
      ds.getRepository(ClientMapping),
      new ClientMappingIdentityService(new EngineRegistry()),
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const contactDto = (over: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    jid: '628111@c.us',
    kind: 'contact' as const,
    name: 'Alice',
    company: 'Acme',
    ...over,
  });

  describe('create', () => {
    it('creates a contact mapping with defaults applied', async () => {
      const mapping = await service.create(contactDto());
      expect(mapping.id).toBeDefined();
      expect(mapping.status).toBe('active');
      expect(mapping.sentimentTracking).toBe(true);
      expect(mapping.phone).toBeNull();
    });

    it('rejects a contact/group mapping with no sessionId', async () => {
      await expect(service.create(contactDto({ sessionId: undefined }))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a teammate mapping that sets sessionId', async () => {
      await expect(
        service.create({
          sessionId: 's1',
          jid: 'alice@acme.com',
          kind: 'teammate',
          name: 'Alice',
          company: 'Acme',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows a teammate mapping with no sessionId', async () => {
      const mapping = await service.create({
        jid: 'alice@acme.com',
        kind: 'teammate',
        name: 'Alice',
        company: 'Acme',
        team: 'Performance',
      });
      expect(mapping.sessionId).toBeNull();
      expect(mapping.team).toBe('Performance');
    });

    it('rejects a duplicate (sessionId, jid, kind) via the DB unique index', async () => {
      await service.create(contactDto());
      await expect(service.create(contactDto({ name: 'Alice again' }))).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows the same jid across two different sessions', async () => {
      await service.create(contactDto());
      await expect(service.create(contactDto({ sessionId: 's2' }))).resolves.toBeDefined();
    });

    it('rejects a duplicate teammate jid via the application-level check', async () => {
      await service.create({ jid: 'alice@acme.com', kind: 'teammate', name: 'Alice', company: 'Acme' });
      await expect(
        service.create({ jid: 'alice@acme.com', kind: 'teammate', name: 'Alice dup', company: 'Acme' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an unknown backupOwnerId', async () => {
      await expect(
        service.create(contactDto({ backupOwnerId: '00000000-0000-0000-0000-000000000000' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a backupOwnerId pointing at an existing mapping', async () => {
      const owner = await service.create(contactDto({ jid: '628222@c.us' }));
      const mapping = await service.create(contactDto({ backupOwnerId: owner.id }));
      expect(mapping.backupOwnerId).toBe(owner.id);
    });
  });

  describe('update', () => {
    it('applies only the provided fields', async () => {
      const mapping = await service.create(contactDto());
      const updated = await service.update(mapping.id, { team: 'Design' });
      expect(updated.team).toBe('Design');
      expect(updated.name).toBe('Alice');
    });

    it('rejects backupOwnerId referencing itself', async () => {
      const mapping = await service.create(contactDto());
      await expect(service.update(mapping.id, { backupOwnerId: mapping.id })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws NotFoundException for an unknown id', async () => {
      await expect(service.update('00000000-0000-0000-0000-000000000000', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    it('filters by kind and company', async () => {
      await service.create(contactDto());
      await service.create({ jid: 'bob@globex.com', kind: 'teammate', name: 'Bob', company: 'Globex' });

      const contacts = await service.findAll({ kind: 'contact' });
      expect(contacts).toHaveLength(1);
      expect(contacts[0].kind).toBe('contact');

      const globex = await service.findAll({ company: 'Globex' });
      expect(globex).toHaveLength(1);
      expect(globex[0].kind).toBe('teammate');
    });

    // The route this backs is @RequireUnscopedKey-gated, so allowedSessions is always null/empty in
    // practice — but resolveSessionScope is threaded through anyway (see the method's doc comment),
    // and that wiring is worth pinning on its own so it stays correct if the gate is ever loosened.
    it('restricts to allowedSessions when the calling key is session-scoped', async () => {
      await service.create(contactDto({ sessionId: 's1' }));
      await service.create(contactDto({ sessionId: 's2', jid: '628333@c.us' }));

      const scoped = await service.findAll({}, ['s1']);
      expect(scoped.map(m => m.sessionId)).toEqual(['s1']);
    });

    it('returns empty when the requested sessionId is outside allowedSessions', async () => {
      await service.create(contactDto({ sessionId: 's2' }));

      const scoped = await service.findAll({ sessionId: 's2' }, ['s1']);
      expect(scoped).toEqual([]);
    });
  });

  describe('remove', () => {
    it('deletes the mapping', async () => {
      const mapping = await service.create(contactDto());
      await service.remove(mapping.id);
      await expect(service.findOne(mapping.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // The shared path every automatic writer (auto-tag, Import from Chats) calls
  // instead of deciding "does this exist" and resolving identity itself.
  describe('resolveAndUpsert', () => {
    it('creates a new contact row when nothing matches by jid or phone', async () => {
      const { mapping, created } = await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '628111@c.us',
        kind: 'contact',
        nameHint: 'Alice',
      });
      expect(created).toBe(true);
      expect(mapping).toMatchObject({ jid: '628111@c.us', name: 'Alice', phone: '628111', company: 'Unknown' });
    });

    it('returns the existing row, unmodified, on an exact jid/kind re-call', async () => {
      const first = await service.resolveAndUpsert({ sessionId: 's1', jid: '628111@c.us', kind: 'contact' });
      const second = await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '628111@c.us',
        kind: 'contact',
        nameHint: 'Should not overwrite',
      });
      expect(second.created).toBe(false);
      expect(second.mapping.id).toBe(first.mapping.id);
      expect(second.mapping.name).toBe(first.mapping.name);
    });

    it('matches an existing row by resolved phone even under a completely different jid (the same-contact-two-jids bug — see docs/32 §5)', async () => {
      const byPhoneJid = await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '919999367045@c.us',
        kind: 'contact',
        nameHint: 'Alex Rivera',
      });
      expect(byPhoneJid.created).toBe(true);

      // A group participant addressed only by a @lid this test's EngineRegistry can't resolve
      // (no engine registered) would fall through with phone=null and create a second row — the
      // exact bug. Simulate the RESOLVED case via phoneHint (what a caller passes once resolution
      // succeeds) to pin the dedup-by-phone behavior itself, independent of engine resolution.
      const byLidJid = await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '30378471473326@lid',
        kind: 'contact',
        nameHint: 'Alex Rivera',
        phoneHint: '919999367045',
      });
      expect(byLidJid.created).toBe(false);
      expect(byLidJid.mapping.id).toBe(byPhoneJid.mapping.id);
      expect(byLidJid.mapping.jid).toBe('919999367045@c.us'); // untouched — not overwritten with the @lid jid
      // The @lid jid isn't silently discarded — it's remembered as an alias of the
      // winning row instead.
      expect(byLidJid.mapping.aliasJids).toBe(JSON.stringify(['30378471473326@lid']));

      const rows = await service.findAll({ sessionId: 's1' });
      expect(rows).toHaveLength(1);
    });

    it('does not duplicate an alias jid already recorded on a repeat match', async () => {
      await service.resolveAndUpsert({ sessionId: 's1', jid: '919999367045@c.us', kind: 'contact' });
      await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '30378471473326@lid',
        kind: 'contact',
        phoneHint: '919999367045',
      });
      const repeatOfSameLid = await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '30378471473326@lid',
        kind: 'contact',
        phoneHint: '919999367045',
      });
      expect(repeatOfSameLid.mapping.aliasJids).toBe(JSON.stringify(['30378471473326@lid']));
    });

    it('accumulates multiple distinct alias jids for the same phone', async () => {
      await service.resolveAndUpsert({ sessionId: 's1', jid: '919999367045@c.us', kind: 'contact' });
      await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '111@lid',
        kind: 'contact',
        phoneHint: '919999367045',
      });
      const { mapping } = await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '222@lid',
        kind: 'contact',
        phoneHint: '919999367045',
      });
      const aliases = JSON.parse(mapping.aliasJids as string) as string[];
      expect(aliases.sort()).toEqual(['111@lid', '222@lid'].sort());
    });

    it('creates a group row keyed by jid — groups never resolve a phone', async () => {
      const { mapping, created } = await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '120363000@g.us',
        kind: 'group',
      });
      expect(created).toBe(true);
      expect(mapping.phone).toBeNull();
    });

    it('creates under the raw jid when phone resolution fails (no engine registered)', async () => {
      const { mapping, created } = await service.resolveAndUpsert({
        sessionId: 's1',
        jid: '99999@lid',
        kind: 'contact',
        nameHint: 'Unknown Lid',
      });
      expect(created).toBe(true);
      expect(mapping).toMatchObject({ jid: '99999@lid', phone: null });
    });

    it('resolves a create race against itself to the winning row instead of throwing', async () => {
      // Simulates two concurrent callers (e.g. the same person in two groups imported at once)
      // racing to create the same (sessionId, jid, kind) row: the DB unique index rejects the
      // second insert, and resolveAndUpsert must hand back the winner rather than propagate the
      // conflict — an automatic writer has no user to show a 409 to.
      const [a, b] = await Promise.all([
        service.resolveAndUpsert({ sessionId: 's1', jid: '628111@c.us', kind: 'contact', nameHint: 'A' }),
        service.resolveAndUpsert({ sessionId: 's1', jid: '628111@c.us', kind: 'contact', nameHint: 'B' }),
      ]);
      expect(a.mapping.id).toBe(b.mapping.id);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(await service.findAll({ sessionId: 's1' })).toHaveLength(1);
    });
  });
});
