import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IngestExternalRecordDto, UpdateRecruitmentApplicationDto, UpdateTalentPoolEntryDto } from './workflow-hub.dto';

describe('workflow hub mutation DTOs', () => {
  it.each([
    ['talent pool entry', UpdateTalentPoolEntryDto],
    ['recruitment application', UpdateRecruitmentApplicationDto],
  ] as const)('%s requires a positive expectedVersion', async (_name, Dto) => {
    const missing = await validate(Object.assign(new Dto(), {}));
    const invalid = await validate(Object.assign(new Dto(), { expectedVersion: 0 }));

    expect(missing.some(error => error.property === 'expectedVersion')).toBe(true);
    expect(invalid.some(error => error.property === 'expectedVersion')).toBe(true);
  });

  it('does not accept allowedChats from an external-ingest request', async () => {
    const dto = plainToInstance(IngestExternalRecordDto, {
      eventKey: 'event-1',
      instanceId: 'flow-1',
      contactId: '5511999990000@c.us',
      answers: {},
      allowedChats: ['5511999990000@c.us'],
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors.some(error => error.property === 'allowedChats')).toBe(true);
  });

  it.each(['5511999990000@c.us', '5511999990000@s.whatsapp.net', '5511999990000@lid', '120363012345678901@g.us'])(
    'accepts the allowedChats contact-id domain for external ingest: %s',
    async contactId => {
      const dto = plainToInstance(IngestExternalRecordDto, {
        eventKey: 'event-1',
        instanceId: 'flow-1',
        contactId,
        answers: {},
      });

      expect((await validate(dto)).filter(error => error.property === 'contactId')).toEqual([]);
    },
  );

  it.each(['not-a-whatsapp-contact', 'status@broadcast', '120363012345678901@newsletter'])(
    'rejects contact IDs outside the documented domain: %s',
    async contactId => {
      const dto = plainToInstance(IngestExternalRecordDto, {
        eventKey: 'event-1',
        instanceId: 'flow-1',
        contactId,
        answers: {},
      });

      expect((await validate(dto)).some(error => error.property === 'contactId')).toBe(true);
    },
  );
});
