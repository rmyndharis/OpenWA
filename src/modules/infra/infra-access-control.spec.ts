// StorageService (imported transitively by the infra controllers) pulls in `archiver`
// v8, which is ESM-only and cannot be parsed by ts-jest. The controller logic
// under test never touches archiver, so a lightweight stub is sufficient.
jest.mock('archiver', () => ({ default: jest.fn() }));

// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
    // so the secret-hygiene path never touches the real filesystem.
    chmodSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
    createReadStream: jest.fn(() => jest.requireActual<typeof import('stream')>('stream').Readable.from([])),
  };
});

import { Reflector } from '@nestjs/core';
import { InfraStatusController } from './infra-status.controller';
import { InfraConfigController } from './infra-config.controller';
import { InfraDataController } from './infra-data.controller';
import { InfraStorageController } from './infra-storage.controller';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

describe('Infra controllers access control (Vuln 2)', () => {
  const reflector = new Reflector();

  // Every mutating, data-exfiltration, and operational-read endpoint must require
  // the ADMIN role so that a low-privilege (VIEWER/OPERATOR) API key cannot wipe
  // data, read secrets, change config, restart, trigger storage import, or read
  // infrastructure status / engine / storage details (#221 tightened the reads).
  const adminOnly = [
    [InfraConfigController, 'getConfig'], // GET  /infra/config (returns saved config; secrets omitted but still ADMIN-only)
    [InfraConfigController, 'saveConfig'], // PUT  /infra/config
    [InfraConfigController, 'requestRestart'], // POST /infra/restart
    [InfraDataController, 'exportData'], // GET  /infra/export-data  (exposes webhook secrets)
    [InfraDataController, 'importData'], // POST /infra/import-data  (DELETEs all rows)
    [InfraStorageController, 'exportStorage'], // GET  /infra/storage/export
    [InfraStorageController, 'importStorage'], // POST /infra/storage/import
    [InfraStatusController, 'getStatus'], // GET  /infra/status
    [InfraStatusController, 'getEngines'], // GET  /infra/engines
    [InfraStatusController, 'getCurrentEngine'], // GET  /infra/engines/current
    [InfraStorageController, 'getStorageFileCount'], // GET  /infra/storage/files/count
  ] as const;

  it.each(
    adminOnly.map(([ControllerClass, method]) => ({
      label: `${ControllerClass.name}.${method}`,
      ControllerClass,
      method,
    })),
  )('$label requires the ADMIN role', ({ ControllerClass, method }) => {
    // The handler is only ever a lookup key for reflector metadata — it is never invoked, so there is
    // no `this` to lose. unbound-method (tightened in typescript-eslint 8.65) cannot tell the two
    // apart, and the cast below does not satisfy it either.

    const handler = ControllerClass.prototype[method as keyof typeof ControllerClass.prototype] as unknown as (
      ...args: unknown[]
    ) => unknown;
    const role = reflector.get<ApiKeyRole | undefined>(REQUIRED_ROLE_KEY, handler);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });
});
