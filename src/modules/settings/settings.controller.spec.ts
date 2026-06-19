import { NotImplementedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SettingsController } from './settings.controller';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

// ConfigService stub: return the supplied default for every key.
const configStub = {
  get: <T>(_key: string, def?: T): T | undefined => def,
} as unknown as ConfigService;

describe('SettingsController', () => {
  it('GET /settings returns the environment-derived settings', () => {
    const settings = new SettingsController(configStub).get();
    expect(settings).toHaveProperty('general');
    expect(settings).toHaveProperty('api');
    expect(settings).toHaveProperty('notifications');
  });

  // The previous PUT mutated an in-memory field and returned 200 'updated' while persisting
  // nothing and applying nothing to the runtime — a false success. Settings are env-derived and
  // read-only at runtime, so the write path must say so (501) rather than fake success.
  it('PUT /settings is read-only and throws 501 instead of a false-success 200', () => {
    const controller = new SettingsController(configStub);
    expect(() => controller.update({})).toThrow(NotImplementedException);
  });

  it('PUT /settings still requires the ADMIN role', () => {
    const proto = SettingsController.prototype as unknown as Record<string, object>;
    const role = new Reflector().get<ApiKeyRole | undefined>(REQUIRED_ROLE_KEY, proto.update);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });
});
