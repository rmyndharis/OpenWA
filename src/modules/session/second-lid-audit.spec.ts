import type { Repository } from 'typeorm';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, type AuditLog } from '../audit/entities/audit-log.entity';
import { LidMappingStoreService, type SecondLidReport } from '../../engine/identity/lid-mapping-store.service';
import type { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { runWithRequestId, setRequestActor } from '../../common/services/request-context';

const ID = '55555555-5555-4555-8555-555555555555';

/**
 * The lid table cannot import the audit log, so the lifecycle registers the listener that turns a phone
 * reported under a second lid into a WARN row naming the phone, both lids and the reporting session.
 */
describe('a phone reported under a second lid', () => {
  it('is written to the audit log by the listener the lifecycle registers', () => {
    let listener: ((report: SecondLidReport) => unknown) | undefined;
    const lidMappingStore = { onSecondLid: jest.fn((fn: typeof listener) => (listener = fn)) };
    const auditService = { logWarn: jest.fn().mockResolvedValue(null) };
    new SessionEngineLifecycle(
      {} as never,
      {} as never,
      {} as never,
      new EngineRegistry(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      auditService as never,
      undefined,
      lidMappingStore as never,
    );

    listener!({ phone: '628999', previousLid: '111', newLid: '222', sessionId: ID });

    expect(auditService.logWarn).toHaveBeenCalledWith(AuditAction.PHONE_SECOND_LID_REPORTED, {
      sessionId: ID,
      metadata: { phone: '628999', previousLid: '111', newLid: '222' },
      errorMessage: expect.stringMatching(/628999.*222.*111/) as string,
    });
  });

  // A whatsapp-web.js send resolves its recipient inside the REST call, so the report starts in that request.
  it('is written with no API key, IP or request id of the request whose send reported the lid', async () => {
    const rows: Partial<LidMapping>[] = [{ lid: '111', phone: '628999', sessionId: 's1', isReported: true }];
    const repo = {
      find: jest.fn(() => Promise.resolve(rows.map(row => ({ ...row })))),
      findOne: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn((values: Partial<LidMapping>) => {
        rows.push(values);
        return Promise.resolve({});
      }),
    };
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    (store as unknown as { secondLidWindowMs: number }).secondLidWindowMs = 0;
    jest
      .spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const save = jest.fn((row: Partial<AuditLog>) => Promise.resolve(row));
    const audit = new AuditService({
      create: (row: Partial<AuditLog>) => row,
      save,
    } as unknown as Repository<AuditLog>);
    const x = {} as never;
    new SessionEngineLifecycle(
      x,
      x,
      x,
      new EngineRegistry(),
      x,
      x,
      x,
      x,
      x,
      x,
      x,
      x,
      x,
      undefined,
      undefined,
      audit,
      undefined,
      store,
    );

    await runWithRequestId('req-send-1', () => {
      setRequestActor({ apiKeyId: 'key-crm', apiKeyName: 'crm-bot', ipAddress: '203.0.113.9' });
      return store.remember('222', '628999', ID);
    });
    await new Promise(resolve => setTimeout(resolve, 20)); // the check's window, set to 0 above

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        action: AuditAction.PHONE_SECOND_LID_REPORTED,
        sessionId: ID,
        apiKeyId: null,
        apiKeyName: null,
        ipAddress: null,
        metadata: { phone: '628999', previousLid: '111', newLid: '222' },
      }),
    );
  });
});
