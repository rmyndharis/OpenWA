import { ConflictException } from '@nestjs/common';
import { IsNull, Not } from 'typeorm';
import { SessionService } from './session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';

const ID = '11111111-1111-4111-8111-111111111111';

function fixture(options: { others: Array<string | null>; own?: string | null; engine?: string }) {
  const row = {
    id: ID,
    name: 'pairing',
    status: SessionStatus.QR_READY,
    phone: options.own ?? null,
    config: {},
  } as Session;
  const repository = {
    findOne: jest.fn().mockResolvedValue(row),
    find: jest.fn().mockResolvedValue(options.others.filter(phone => phone !== null).map(phone => ({ phone }))),
  };
  const state = { attachTo: <T>(value: T): T => value };
  const engine = { requestPairingCode: jest.fn().mockResolvedValue('ABCD1234') };
  const registry = new EngineRegistry();
  registry.set(ID, engine as never);
  const config = { get: jest.fn((key: string) => (key === 'engine.type' ? options.engine : undefined)) };
  const service = new SessionService(
    repository as never,
    {} as never,
    {} as never,
    registry,
    {} as never,
    state as never,
    state as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    config as never,
  );
  return { service, repository, engine };
}

describe('SessionService.requestPairingCode', () => {
  it('refuses a number another session stores as its phone on whatsapp-web.js, without asking WhatsApp', async () => {
    const { service, repository, engine } = fixture({ others: ['628111000111'], engine: 'whatsapp-web.js' });

    await expect(service.requestPairingCode(ID, '628111000111')).rejects.toBeInstanceOf(ConflictException);

    expect(repository.find).toHaveBeenCalledWith({
      where: { id: Not(ID), phone: Not(IsNull()) },
      select: { phone: true },
    });
    expect(engine.requestPairingCode).not.toHaveBeenCalled();
  });

  it('defaults to whatsapp-web.js when the engine type is not configured', async () => {
    const { service, engine } = fixture({ others: ['628111000111'] });

    await expect(service.requestPairingCode(ID, '628111000111')).rejects.toBeInstanceOf(ConflictException);

    expect(engine.requestPairingCode).not.toHaveBeenCalled();
  });

  it.each([
    ['Brazil, typed without the ninth digit', '5511987654321', '551187654321'],
    ['Brazil, typed with the ninth digit', '551187654321', '5511987654321'],
    ['Mexico, typed without the 1', '5215512345678', '525512345678'],
    ['Mexico, typed with the 1', '525512345678', '5215512345678'],
    ['Argentina, typed without the 9', '5491123456789', '541123456789'],
    ['Argentina, typed with the 9', '541123456789', '5491123456789'],
  ])('refuses another spelling of the same number: %s', async (_family, stored, typed) => {
    const { service, engine } = fixture({ others: [stored], engine: 'whatsapp-web.js' });

    await expect(service.requestPairingCode(ID, typed)).rejects.toBeInstanceOf(ConflictException);

    expect(engine.requestPairingCode).not.toHaveBeenCalled();
  });

  it('asks for a code for a number no other session stores, including the session own number', async () => {
    const { service, engine } = fixture({
      others: ['628222000222', null],
      own: '628111000111',
      engine: 'whatsapp-web.js',
    });

    await expect(service.requestPairingCode(ID, '628111000111')).resolves.toEqual({
      pairingCode: 'ABCD1234',
      status: SessionStatus.QR_READY,
    });

    expect(engine.requestPairingCode).toHaveBeenCalledWith('628111000111');
  });

  it('does not treat a different number with a similar prefix as the same', async () => {
    const { service, engine } = fixture({ others: ['5511987654321'], engine: 'whatsapp-web.js' });

    await service.requestPairingCode(ID, '5511987654322');

    expect(engine.requestPairingCode).toHaveBeenCalledWith('5511987654322');
  });

  it('leaves Baileys alone: its sessions are companion devices and may share a number', async () => {
    const { service, repository, engine } = fixture({ others: ['628111000111'], engine: 'baileys' });

    await expect(service.requestPairingCode(ID, '628111000111')).resolves.toMatchObject({ pairingCode: 'ABCD1234' });

    expect(repository.find).not.toHaveBeenCalled();
    expect(engine.requestPairingCode).toHaveBeenCalledWith('628111000111');
  });
});
