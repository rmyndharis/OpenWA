// archiver v8 is ESM-only and is pulled in transitively via the @Global StorageModule when
// AppModule boots; stub it so ts-jest (CommonJS) can load the module graph (same as other e2e specs).
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

// Seed the well-known dev-admin-key (ApiKeyRole.ADMIN, so it satisfies @RequireRole(OPERATOR))
// BEFORE AppModule is imported, mirroring integration-instance.e2e-spec.ts's env-first pattern.
process.env.ALLOW_DEV_API_KEY = 'true';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Message, MessageDirection } from '../src/modules/message/entities/message.entity';
import { AddMessagesFts1782400000000 } from '../src/database/migrations/1782400000000-AddMessagesFts';
import { SearchController } from '../src/modules/search/search.controller';
import { SearchService } from '../src/modules/search/search.service';
import { SearchProviderRegistry } from '../src/modules/search/search-provider.registry';

/**
 * End-to-end coverage for the global search integration capstone (Task 10): the real /api/search
 * route → SearchController → SearchService → SearchProviderRegistry → BuiltInFtsProvider →
 * `messages` FTS schema (SQLite FTS5 here, Postgres tsvector in the provider's own spec). Bootstraps
 * the full AppModule so the SEARCH_BOOTSTRAP factory, the `@InjectDataSource('data')` wiring, and the
 * conditional `SEARCH_ENABLED` gate are all exercised exactly as production runs them.
 *
 * setup-e2e.ts sets DATABASE_SYNCHRONIZE=true, so TypeORM creates the `messages` table from the entity
 * but the FTS virtual table + triggers come from a MIGRATION that doesn't run under synchronize. The
 * spec applies that migration's up() manually after boot — proving the provider queries the FTS schema
 * the migration establishes, not a test-only stub.
 */
describe('GET /api/search (e2e)', () => {
  let app: INestApplication<App>;
  let messageRepo: Repository<Message>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    // The FTS migration is gated behind migrationsRun (off under DATABASE_SYNCHRONIZE=true), so apply
    // it manually here against the 'data' connection that owns `messages`. This is the same shape the
    // provider's own spec uses, and proves the e2e path queries a real FTS index, not a stand-in.
    const dataSource = app.get<DataSource>(getDataSourceToken('data'));
    await new AddMessagesFts1782400000000().up(dataSource.createQueryRunner());

    messageRepo = app.get<Repository<Message>>(getRepositoryToken(Message, 'data'));
    await messageRepo.insert([
      {
        sessionId: 'sess-search-1',
        chatId: 'chat-1@c.us',
        from: 'alice@c.us',
        to: 'bot@c.us',
        body: 'hello world from search e2e',
        type: 'text',
        direction: MessageDirection.OUTGOING,
        timestamp: 1700000000000,
      },
      {
        sessionId: 'sess-search-1',
        chatId: 'chat-1@c.us',
        from: 'bob@c.us',
        to: 'bot@c.us',
        body: 'completely unrelated body text',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1700000001000,
      },
    ]);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('returns matching hits over the full route → provider → FTS stack (200)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/search?q=hello')
      .set('X-API-Key', 'dev-admin-key')
      .expect(200);

    const body = res.body as {
      hits: Array<{ body: string; sessionId: string; snippet: string }>;
      total: number;
      provider: string;
    };
    expect(body.provider).toBe('builtin-fts');
    expect(body.total).toBe(1);
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0].body).toContain('hello world');
    expect(body.hits[0].sessionId).toBe('sess-search-1');
    // The SQLite snippet() wrapper highlights the match term with <mark> — proves the FTS index answered.
    expect(body.hits[0].snippet).toContain('<mark>hello</mark>');
  });

  it('returns 400 for an empty / whitespace-only q', async () => {
    // The DTO's @IsNotEmpty() surfaces as a 400 via the global ValidationPipe before the controller's
    // own non-empty check runs; both paths converge on 400, which is the contract.
    await request(app.getHttpServer()).get('/api/search?q=').set('X-API-Key', 'dev-admin-key').expect(400);
    await request(app.getHttpServer()).get('/api/search?q=%20%20').set('X-API-Key', 'dev-admin-key').expect(400);
  });

  it('requires an API key (401 without one)', async () => {
    await request(app.getHttpServer()).get('/api/search?q=hello').expect(401);
  });

  it('returns an empty result page (not 501) for a non-matching term', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/search?q=zzzznomatch')
      .set('X-API-Key', 'dev-admin-key')
      .expect(200);
    const body = res.body as { hits: unknown[]; total: number };
    expect(body.hits).toEqual([]);
    expect(body.total).toBe(0);
  });

  // Exercises the SEARCH_BOOTSTRAP factory + the `@InjectDataSource('data')` wiring: the controller,
  // service, registry, and an ACTIVE provider are all resolvable from the booted DI graph, and the
  // registry reports builtin-fts as active (so the route is live, not 501). This is the registration-
  // level proof that SearchModule's providers and bootstrap factory wired correctly.
  it('registers SearchModule with the built-in provider active (not 501)', () => {
    expect(() => app.get(SearchController)).not.toThrow();
    expect(() => app.get(SearchService)).not.toThrow();
    const registry = app.get(SearchProviderRegistry);
    expect(registry.active()?.id).toBe('builtin-fts');
  });
});

/**
 * The SEARCH_ENABLED=false gate (src/app.module.ts): the top-level conditional only pushes
 * SearchModule into `searchModules` (spread into AppModule's @Module imports) when the env is not
 * 'false', so an opt-out deployment never imports SearchModule at all — no route, controller,
 * service, registry, or provider (zero footprint, no 501 surface).
 *
 * Rather than re-implementing the gate branch locally (which would only assert a copy of the logic
 * and miss a regression in the real one), this re-evaluates the REAL app.module.ts under each env
 * (jest.isolateModules gives a fresh registry so the top-level conditional re-runs with the env we
 * set) and reads the ACTUAL @Module({ imports }) metadata, asserting whether SearchModule is present.
 * A full route-404 e2e would need a separately-booted app in a different process/env, which is why the
 * main describe above boots only the default (ON) instance; this pins the real opt-out decision.
 */
describe('SEARCH_ENABLED gate (real AppModule imports)', () => {
  // Re-requires the REAL app.module.ts under a fresh module registry with SEARCH_ENABLED=`value`,
  // then reports whether its actual @Module({ imports }) contains SearchModule. require() (not a
  // dynamic import()) avoids the TS2835 extension requirement under moduleResolution:nodenext.
  const searchModuleImportedWhen = (value: string | undefined): boolean => {
    const previous = process.env.SEARCH_ENABLED;
    if (value === undefined) delete process.env.SEARCH_ENABLED;
    else process.env.SEARCH_ENABLED = value;
    try {
      let imported = false;
      jest.isolateModules(() => {
        /* eslint-disable @typescript-eslint/no-require-imports -- require() (not a dynamic import())
           is the jest pattern for a fresh-evaluation read; the nodenext TS2835 extension rule only
           applies to ES imports, and a dynamic import() would need a separate tsconfig for specs. */
        const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
        const { SearchModule } =
          require('../src/modules/search/search.module') as typeof import('../src/modules/search/search.module');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const imports: unknown[] = (Reflect.getMetadata('imports', AppModule) as unknown[]) ?? [];
        imported = imports.includes(SearchModule);
      });
      return imported;
    } finally {
      if (previous === undefined) delete process.env.SEARCH_ENABLED;
      else process.env.SEARCH_ENABLED = previous;
    }
  };

  it('imports SearchModule by default (SEARCH_ENABLED unset)', () => {
    expect(searchModuleImportedWhen(undefined)).toBe(true);
  });

  it('imports SearchModule when explicitly enabled', () => {
    expect(searchModuleImportedWhen('true')).toBe(true);
  });

  it('omits SearchModule entirely when SEARCH_ENABLED=false (route cannot register)', () => {
    expect(searchModuleImportedWhen('false')).toBe(false);
  });
});
