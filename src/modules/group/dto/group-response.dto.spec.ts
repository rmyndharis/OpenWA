import 'reflect-metadata';
import { DECORATORS } from '@nestjs/swagger';
import type { GroupMetadata } from '@whiskeysockets/baileys';
import { GroupParticipantDto } from './group-response.dto';
import { mapBaileysGroupInfo } from '../../../engine/adapters/baileys-group-mapper';
import { WwebjsGroups } from '../../../engine/adapters/wwebjs-groups';
import type { WwebjsEngineHost } from '../../../engine/adapters/wwebjs-host';

const description = (key: string): string | undefined =>
  (
    Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, GroupParticipantDto.prototype, key) as
      { description?: string } | undefined
  )?.description;

// A lid's digits are not a phone number, so the published text has to say what `number` holds for a participant
// known only by its lid. Each case reads what both engines emit next to the text that describes it.
describe('GroupParticipantDto.number', () => {
  it('publishes that a participant known only by its lid carries the lid digits', () => {
    expect(description('number')).toBe(
      'MSISDN digits, without a leading + or separators, for a `<phone>@c.us` participant. For a `<lid>@lid` ' +
        "participant it carries the lid's digits on both engines, which are not a phone number.",
    );
  });

  it('is the lid digits on Baileys for a lid participant and the phone digits for a phone one', () => {
    const metadata = {
      id: '120363000000000001@g.us',
      subject: 'Team',
      participants: [
        { id: '123456789012345@lid', admin: null },
        { id: '223456789012345@lid', phoneNumber: '628123456789@s.whatsapp.net', admin: null },
      ],
    } as unknown as GroupMetadata;

    const participants = mapBaileysGroupInfo(metadata, jid => jid.replace('@s.whatsapp.net', '@c.us')).participants;

    expect(participants.map(p => ({ id: p.id, number: p.number }))).toEqual([
      { id: '123456789012345@lid', number: '123456789012345' },
      { id: '628123456789@c.us', number: '628123456789' },
    ]);
  });

  it('is the lid digits on whatsapp-web.js for a lid participant', async () => {
    const chat = {
      id: { _serialized: '120363000000000001@g.us' },
      name: 'Team',
      isGroup: true,
      participants: [
        { id: { _serialized: '123456789012345@lid', user: '123456789012345', server: 'lid' }, isAdmin: false },
      ],
      groupMetadata: {},
    };
    const host = {
      ensureReady: () => undefined,
      getClient: () => ({ getChatById: () => Promise.resolve(chat), info: { wid: { _serialized: 'me@c.us' } } }),
    } as unknown as WwebjsEngineHost;

    const info = await new WwebjsGroups(host).getGroupInfo('120363000000000001@g.us');

    expect(info?.participants.map(p => ({ id: p.id, number: p.number }))).toEqual([
      { id: '123456789012345@lid', number: '123456789012345' },
    ]);
  });
});
