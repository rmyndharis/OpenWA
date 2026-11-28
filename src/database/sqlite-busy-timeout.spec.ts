import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConfigService } from '@nestjs/config';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { mainConnectionOptions } from './main-connection';
import { AppModule } from '../app.module';
import { InfraDataService } from '../modules/infra/infra-data.service';
import { LoggerService } from '../common/services/logger.service';

interface FactoryProvider {
  provide?: unknown;
  useFactory?: (config: ConfigService) => Record<string, unknown>;
}
interface DynamicModuleLike {
  imports?: DynamicModuleLike[];
  providers?: FactoryProvider[];
}

const config = (values: Record<string, unknown> = {}): ConfigService =>
  ({ get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback) }) as unknown as ConfigService;

/**
 * Every TypeORM options factory AppModule registers, found through its dynamic module imports. Only the
 * `TypeOrmModuleOptions` providers are taken: the DataSource factories beside them open a real connection.
 */
function typeOrmOptionFactories(): Array<(config: ConfigService) => Record<string, unknown>> {
  const found: Array<(config: ConfigService) => Record<string, unknown>> = [];
  const visit = (mod: DynamicModuleLike): void => {
    for (const p of mod.providers ?? []) {
      if (p?.provide === 'TypeOrmModuleOptions' && typeof p.useFactory === 'function') found.push(p.useFactory);
    }
    for (const child of mod.imports ?? []) if (child && typeof child === 'object') visit(child);
  };
  for (const imported of (Reflect.getMetadata('imports', AppModule) as DynamicModuleLike[]) ?? []) {
    if (imported && typeof imported === 'object') visit(imported);
  }
  return found;
}

// scripts/backup.sh holds a read transaction for the whole online copy of each SQLite file, which
// blocks app writes until it ends. better-sqlite3's 5 s default busy timeout failed those writes on
// a copy that ran longer, so both runtime connections wait as long as the backup's own timeout.
describe('SQLite busy timeout', () => {
  it('lets main-connection writes wait out an online backup', () => {
    expect(mainConnectionOptions(config())).toMatchObject({ type: 'better-sqlite3', timeout: 30_000 });
  });

  const dataOptions = (values: Record<string, unknown> = {}) =>
    typeOrmOptionFactories()
      .map(factory => {
        try {
          return factory(config({ 'dataDatabase.type': 'sqlite', ...values }));
        } catch {
          return null;
        }
      })
      .find(options => options?.name === 'data');

  it('lets data-connection writes wait out an online backup', () => {
    expect(dataOptions()).toMatchObject({ type: 'better-sqlite3', timeout: 30_000 });
  });

  // A restore into a SQLite file writes on a connection of its own, which meets the backup's read transaction too.
  it('lets the connection a restore writes on wait out an online backup', async () => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), 'owa-busy-timeout-'));
    const options = dataOptions({
      'dataDatabase.database': join(dir, 'data.sqlite'),
      'dataDatabase.synchronize': true,
    });
    const ds = await new DataSource(options as unknown as DataSourceOptions).initialize();
    const opened: Array<DataSourceOptions> = [];
    const initialize = Reflect.get<DataSource, 'initialize'>(DataSource.prototype, 'initialize');
    jest.spyOn(DataSource.prototype, 'initialize').mockImplementation(function (this: DataSource) {
      opened.push(this.options);
      return initialize.call(this);
    });
    try {
      const cfg = { get: (key: string, fallback?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : fallback) };
      const at = '2026-01-01 00:00:00.000';
      const sessions = [{ id: 's1', name: 'main', status: 'disconnected', config: '{}', createdAt: at, updatedAt: at }];
      const result = await new InfraDataService(cfg as never, ds).importData({ tables: { sessions } as never });

      expect(result).toMatchObject({ imported: true });
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ type: 'better-sqlite3', database: options?.database, timeout: 30_000 });
    } finally {
      jest.restoreAllMocks();
      await ds.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
