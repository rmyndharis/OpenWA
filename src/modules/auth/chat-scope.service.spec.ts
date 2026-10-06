import { ForbiddenException } from '@nestjs/common';
import { ChatScopeService } from './chat-scope.service';
import { FindOperator, Repository } from 'typeorm';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';

const PHONE = '919999999999';
const LID = '555000111';

/** Deterministic persisted-lookup stand-in; the real service reads the lid table on a cache miss. */
function fakeStore(): LidMappingStoreService {
  return {
    findPhoneForLid: jest.fn((lid: string) => Promise.resolve(lid === LID ? PHONE : null)),
    findLidsForPhone: jest.fn((phone: string) => Promise.resolve(phone === PHONE ? [LID] : [])),
    phonesForLidsPersisted: jest.fn((lids: string[]) =>
      Promise.resolve(Object.fromEntries(lids.map(lid => [lid, lid === LID ? PHONE : null]))),
    ),
    lidsForPhonesPersisted: jest.fn((phones: string[]) =>
      Promise.resolve(Object.fromEntries(phones.map(phone => [phone, phone === PHONE ? [LID] : []]))),
    ),
  } as unknown as LidMappingStoreService;
}

describe('ChatScopeService', () => {
  it('requireChat refuses a restricted key that names no chat, and nothing else', () => {
    const svc = new ChatScopeService();
    const restricted = { allowedChats: ['1@c.us'] };
    for (const chatId of [undefined, '', '   ']) {
      expect(() => svc.requireChat(restricted, chatId)).toThrow(ForbiddenException);
    }
    expect(() => svc.requireChat(restricted, '1@c.us')).not.toThrow();
    expect(() => svc.requireChat({ allowedChats: null }, undefined)).not.toThrow();
    expect(() => svc.requireChat(undefined, undefined)).not.toThrow();
  });

  it('is unrestricted without an allowlist', async () => {
    const svc = new ChatScopeService();
    expect(svc.isRestricted({ allowedChats: null })).toBe(false);
    expect(svc.isRestricted({ allowedChats: [] })).toBe(false);
    expect(svc.scopeFor({ allowedChats: null })).toBeNull();
    expect(await svc.allows({ allowedChats: null }, '123@g.us')).toBe(true);
  });

  it('matches a phone entry to its lid through the persisted directory', async () => {
    const svc = new ChatScopeService(fakeStore());
    expect(svc.isRestricted({ allowedChats: [`${PHONE}@c.us`] })).toBe(true);
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${LID}@lid`)).toBe(true);
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, '888000222@lid')).toBe(false);
  });

  it('does not admit the same-digits @c.us for a @lid entry', async () => {
    const svc = new ChatScopeService(fakeStore());
    expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${LID}@c.us`)).toBe(false);
    expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${LID}@lid`)).toBe(true);
    expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${PHONE}@c.us`)).toBe(true);
  });

  it('filters a list through the batched expansion, passing an unrestricted key through', async () => {
    const svc = new ChatScopeService(fakeStore());
    const rows = [{ id: '123@g.us' }, { id: `${LID}@lid` }, { id: '999@g.us' }];
    expect(await svc.filter({ allowedChats: [`${PHONE}@c.us`] }, rows, r => r.id)).toEqual([{ id: `${LID}@lid` }]);
    expect(await svc.filter({ allowedChats: null }, rows, r => r.id)).toEqual(rows);
  });

  it('idsForFilter returns the expanded id array, or undefined when unrestricted', async () => {
    const svc = new ChatScopeService(fakeStore());
    const ids = await svc.idsForFilter({ allowedChats: [`${PHONE}@c.us`, '120@g.us'] });
    expect(ids).toEqual(expect.arrayContaining([`${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`, `${LID}@lid`, '120@g.us']));
    expect(await svc.idsForFilter({ allowedChats: null })).toBeUndefined();
    expect(await svc.idsForFilter({ allowedChats: [] })).toBeUndefined();
    expect(await svc.idsForFilter({ allowedChats: ['not-a-chat'] })).toEqual([]);
    expect(await svc.idsForFilter(undefined)).toBeUndefined();
  });

  it('does not admit a phone whose lid another node has re-mapped', async () => {
    const rows = [{ lid: LID, phone: PHONE as string | null }];
    const hit = (value: string | null, cond?: string | FindOperator<unknown>) =>
      cond === undefined || (cond instanceof FindOperator ? (cond.value as unknown[]).includes(value) : value === cond);
    const repo = {
      find: jest.fn(
        (o?: { where?: { lid?: string | FindOperator<unknown>; phone?: string | FindOperator<unknown> } }) =>
          Promise.resolve(rows.filter(r => hit(r.lid, o?.where?.lid) && hit(r.phone, o?.where?.phone))),
      ),
      findOne: jest.fn((o: { where: { lid: string } }) =>
        Promise.resolve(rows.find(r => r.lid === o.where.lid) ?? null),
      ),
    };
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit(); // the cache now indexes LID -> PHONE
    rows[0].phone = '918888888888'; // another node re-mapped the lid in the shared table
    const svc = new ChatScopeService(store);
    expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${PHONE}@c.us`)).toBe(false);
    // Until this node learns the re-map, the disagreement fails closed for the new phone too.
    expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, '918888888888@c.us')).toBe(false);
  });

  it('degrades to exact dialects when no lid directory is available', async () => {
    const svc = new ChatScopeService();
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${LID}@lid`)).toBe(false);
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${PHONE}@c.us`)).toBe(true);
  });
});
