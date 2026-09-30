import { Reflector } from '@nestjs/core';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { RedriveController } from './redrive.controller';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { PluginInstanceService } from './plugin-instance.service';
import { RedriveService } from './redrive.service';

describe('RedriveController authz', () => {
  it('is ADMIN-gated (re-dispatching DLQ payloads can cause real sends; a VIEWER/OPERATOR key must not)', () => {
    // The ApiKeyGuard only enforces a role when REQUIRED_ROLE_KEY metadata is present; without this
    // decorator any authenticated key (incl. read-only VIEWER) could POST the redrive action.
    const role = new Reflector().get<ApiKeyRole>(REQUIRED_ROLE_KEY, RedriveController);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });
});

// The instance's session binding lives in the persisted row, which the ApiKeyGuard's route-param
// fence never sees — the controller must confine a session-scoped key itself.
describe('RedriveController session-scope fence', () => {
  const scopedKey = { allowedSessions: ['sess-1'] } as ApiKey;

  function build(sessionScope: string | null | undefined, enabled?: boolean) {
    const redrive = { redriveInstance: jest.fn().mockResolvedValue({ redriven: 0, remaining: 0, batchSize: 100 }) };
    const instances = {
      resolve: jest
        .fn()
        .mockResolvedValue(
          sessionScope === undefined ? null : { pluginId: 'chatwoot', instanceId: 'acct1', sessionScope, enabled },
        ),
    };
    const audit = { logInfo: jest.fn() };
    const controller = new RedriveController(
      redrive as unknown as RedriveService,
      instances as unknown as PluginInstanceService,
      audit as unknown as AuditService,
    );
    return { controller, redrive, audit };
  }

  it('lets a scoped key redrive an instance bound to one of its sessions, passing the current binding as a provenance filter', async () => {
    // A scoped key is authorized against the instance's CURRENT sessionScope, but the DLQ also holds
    // historical rows from prior bindings. The controller must thread that authorized binding down so
    // the service can filter by it — otherwise the key replays foreign (sess-old) rows.
    const { controller, redrive } = build('sess-1');

    await controller.redriveInstance('chatwoot', 'acct1', scopedKey);

    expect(redrive.redriveInstance).toHaveBeenCalledWith('chatwoot', 'acct1', 'sess-1');
  });

  it('answers 404 when a scoped key redrives an out-of-scope instance (and never dispatches)', async () => {
    const { controller, redrive } = build('sess-2');

    await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    expect(redrive.redriveInstance).not.toHaveBeenCalled();
  });

  it('answers 404 when a scoped key redrives a missing instance (its retained DLQ rows still carry a sessionId that may be out of scope)', async () => {
    // build(undefined) makes resolve() return null (the instance row is gone). The old guard's
    // `inst && ...` short-circuit let a scoped key through to redriveInstance here, re-dispatching
    // the deleted instance's retained DLQ rows unscoped. It must fail closed instead.
    const { controller, redrive } = build(undefined);

    await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    expect(redrive.redriveInstance).not.toHaveBeenCalled();
  });

  it('answers 409 when an unrestricted key redrives a missing instance (dispatch would refuse every row)', async () => {
    // Dispatch refuses a deleted instance, so a replay could only fail again, and a queued replay
    // would still retire its DLQ row as redriven. Refused before the service is reached.
    const { controller, redrive, audit } = build(undefined);

    await expect(
      controller.redriveInstance('chatwoot', 'acct1', { allowedSessions: null } as unknown as ApiKey),
    ).rejects.toThrow(ConflictException);
    expect(redrive.redriveInstance).not.toHaveBeenCalled();
    expect(audit.logInfo).not.toHaveBeenCalled();
  });

  it('answers 409 when redriving a disabled instance, for scoped and unrestricted keys alike', async () => {
    for (const apiKey of [scopedKey, { allowedSessions: null } as unknown as ApiKey]) {
      const { controller, redrive } = build('sess-1', false);

      await expect(controller.redriveInstance('chatwoot', 'acct1', apiKey)).rejects.toThrow(ConflictException);
      expect(redrive.redriveInstance).not.toHaveBeenCalled();
    }
  });

  it('keeps answering 404, not 409, when a scoped key redrives an out-of-scope disabled instance', async () => {
    // The scope fence runs first so a disabled instance in another session is not revealed.
    const { controller } = build('sess-2', false);

    await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
  });

  it('answers 404 when a scoped key redrives an all-sessions (null scope) instance', async () => {
    const { controller, redrive } = build(null);

    await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    expect(redrive.redriveInstance).not.toHaveBeenCalled();
  });

  it('lets an unrestricted key redrive any instance, passing null as an unrestricted provenance filter', async () => {
    const { controller, redrive } = build('sess-2');

    await controller.redriveInstance('chatwoot', 'acct1', { allowedSessions: null } as unknown as ApiKey);

    expect(redrive.redriveInstance).toHaveBeenCalledWith('chatwoot', 'acct1', null);
  });

  it('audits a successful redrive with its outcome counts (a redrive can cause real sends)', async () => {
    const { controller, redrive, audit } = build('sess-1');
    redrive.redriveInstance.mockResolvedValue({ redriven: 3, remaining: 7, batchSize: 100 });

    await controller.redriveInstance('chatwoot', 'acct1', scopedKey);

    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.INTEGRATION_INSTANCE_REDRIVEN, {
      metadata: { pluginId: 'chatwoot', instanceId: 'acct1', redriven: 3, remaining: 7 },
    });
  });

  it('does not audit a rejected (out-of-scope) redrive', async () => {
    const { controller, audit } = build('sess-2');

    await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    expect(audit.logInfo).not.toHaveBeenCalled();
  });
});
