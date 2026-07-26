import { Reflector } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';
import { RedriveController } from './redrive.controller';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
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

  function build(sessionScope: string | null) {
    const redrive = { redriveInstance: jest.fn().mockResolvedValue({ redriven: 0, remaining: 0, batchSize: 100 }) };
    const instances = {
      resolve: jest
        .fn()
        .mockResolvedValue(
          sessionScope === undefined ? null : { pluginId: 'chatwoot', instanceId: 'acct1', sessionScope },
        ),
    };
    const controller = new RedriveController(
      redrive as unknown as RedriveService,
      instances as unknown as PluginInstanceService,
    );
    return { controller, redrive };
  }

  it('lets a scoped key redrive an instance bound to one of its sessions', async () => {
    const { controller, redrive } = build('sess-1');

    await controller.redriveInstance('chatwoot', 'acct1', scopedKey);

    expect(redrive.redriveInstance).toHaveBeenCalledWith('chatwoot', 'acct1');
  });

  it('answers 404 when a scoped key redrives an out-of-scope instance (and never dispatches)', async () => {
    const { controller, redrive } = build('sess-2');

    await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    expect(redrive.redriveInstance).not.toHaveBeenCalled();
  });

  it('answers 404 when a scoped key redrives an all-sessions (null scope) instance', async () => {
    const { controller, redrive } = build(null);

    await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    expect(redrive.redriveInstance).not.toHaveBeenCalled();
  });

  it('lets an unrestricted key redrive any instance', async () => {
    const { controller, redrive } = build('sess-2');

    await controller.redriveInstance('chatwoot', 'acct1', { allowedSessions: null } as unknown as ApiKey);

    expect(redrive.redriveInstance).toHaveBeenCalledWith('chatwoot', 'acct1');
  });
});
