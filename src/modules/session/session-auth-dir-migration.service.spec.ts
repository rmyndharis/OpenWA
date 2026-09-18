import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { SessionAuthDirMigration } from './session-auth-dir-migration.service';
import { Session } from './entities/session.entity';

// Real temporary directories throughout: the whole point of the migration is what it does to the
// filesystem, and the case-insensitivity trap it avoids is invisible to a mocked fs.
describe('SessionAuthDirMigration', () => {
  const ALICE_ID = '8f5b1d9e-0c4a-4e21-9d6b-2a7c3f0e1b44';
  const BOB_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

  let tmpRoot: string;
  let sessionsDir: string;
  let baileysDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-dir-migration-'));
    sessionsDir = path.join(tmpRoot, 'sessions');
    baileysDir = path.join(tmpRoot, 'baileys');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const buildMigration = (rows: Array<Pick<Session, 'id' | 'name'>>): SessionAuthDirMigration => {
    const repository = { find: jest.fn().mockResolvedValue(rows) } as unknown as Repository<Session>;
    const values: Record<string, unknown> = {
      'engine.sessionDataPath': sessionsDir,
      'engine.baileys.authDir': baileysDir,
    };
    const configService = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
    return new SessionAuthDirMigration(repository, configService);
  };

  const seed = (dir: string, marker: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), marker);
  };

  const markerAt = (dir: string): string => fs.readFileSync(path.join(dir, 'creds.json'), 'utf8');

  it('renames the legacy name-keyed directories of both engines onto the session id', async () => {
    seed(path.join(sessionsDir, 'session-alice'), 'wwjs-alice');
    seed(path.join(baileysDir, 'alice'), 'baileys-alice');

    await buildMigration([{ id: ALICE_ID, name: 'alice' }]).onModuleInit();

    expect(markerAt(path.join(sessionsDir, `session-${ALICE_ID}`))).toBe('wwjs-alice');
    expect(markerAt(path.join(baileysDir, ALICE_ID))).toBe('baileys-alice');
    expect(fs.existsSync(path.join(sessionsDir, 'session-alice'))).toBe(false);
    expect(fs.existsSync(path.join(baileysDir, 'alice'))).toBe(false);
  });

  it('is a no-op when the id-keyed directory is already the only one (a second boot)', async () => {
    seed(path.join(sessionsDir, `session-${ALICE_ID}`), 'wwjs-alice');
    seed(path.join(baileysDir, ALICE_ID), 'baileys-alice');

    const migration = buildMigration([{ id: ALICE_ID, name: 'alice' }]);
    await migration.onModuleInit();
    await migration.onModuleInit();

    expect(markerAt(path.join(sessionsDir, `session-${ALICE_ID}`))).toBe('wwjs-alice');
    expect(fs.readdirSync(sessionsDir)).toEqual([`session-${ALICE_ID}`]);
    expect(fs.readdirSync(baileysDir)).toEqual([ALICE_ID]);
  });

  it('leaves both directories in place and warns when a legacy and an id-keyed one coexist', async () => {
    seed(path.join(sessionsDir, 'session-alice'), 'legacy');
    seed(path.join(sessionsDir, `session-${ALICE_ID}`), 'current');
    const migration = buildMigration([{ id: ALICE_ID, name: 'alice' }]);
    const warn = jest
      .spyOn((migration as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);

    await migration.onModuleInit();

    expect(markerAt(path.join(sessionsDir, 'session-alice'))).toBe('legacy');
    expect(markerAt(path.join(sessionsDir, `session-${ALICE_ID}`))).toBe('current');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('alice'),
      expect.objectContaining({ action: 'auth_dir_migration_conflict' }),
    );
  });

  it('does nothing on a fresh install, where neither base directory exists', async () => {
    await expect(buildMigration([{ id: ALICE_ID, name: 'alice' }]).onModuleInit()).resolves.toBeUndefined();

    expect(fs.existsSync(sessionsDir)).toBe(false);
    expect(fs.existsSync(baileysDir)).toBe(false);
  });

  // The #1597 scenario: on a case-insensitive filesystem `alice` and `Alice` are two rows sharing
  // ONE directory. Matching the on-disk entry name exactly (rather than asking existsSync) is what
  // stops the migration handing `alice`'s WhatsApp login to `Alice`.
  it('moves only the directory whose stored name matches exactly, never a case variant', async () => {
    seed(path.join(sessionsDir, 'session-alice'), 'wwjs-alice');

    // `Alice` is listed FIRST, so an existsSync-based check would rename the directory onto its id
    // before `alice` is reached. The two assertions only diverge on a case-insensitive filesystem,
    // which is where the bug lives and which CI is not; on a case-sensitive one they hold trivially.
    await buildMigration([
      { id: BOB_ID, name: 'Alice' },
      { id: ALICE_ID, name: 'alice' },
    ]).onModuleInit();

    expect(markerAt(path.join(sessionsDir, `session-${ALICE_ID}`))).toBe('wwjs-alice');
    expect(fs.existsSync(path.join(sessionsDir, `session-${BOB_ID}`))).toBe(false);
  });

  it('warns that only one of two case-colliding sessions keeps its stored login', async () => {
    seed(path.join(sessionsDir, 'session-alice'), 'wwjs-alice');
    const migration = buildMigration([
      { id: ALICE_ID, name: 'alice' },
      { id: BOB_ID, name: 'Alice' },
    ]);
    const warn = jest
      .spyOn((migration as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);

    await migration.onModuleInit();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('differ only in letter case'),
      expect.objectContaining({ action: 'auth_dir_case_collision' }),
    );
  });

  // Names cannot be renamed, so a warning that ignores the disk would repeat at every boot forever,
  // and on a case-sensitive filesystem (or for names created after the upgrade) it is simply untrue:
  // each row has always had a directory of its own.
  it('stays silent about case-colliding names when no legacy directory was found for them', async () => {
    seed(path.join(sessionsDir, `session-${ALICE_ID}`), 'wwjs-alice');
    seed(path.join(baileysDir, BOB_ID), 'baileys-bob');
    const migration = buildMigration([
      { id: ALICE_ID, name: 'alice' },
      { id: BOB_ID, name: 'Alice' },
    ]);
    const warn = jest
      .spyOn((migration as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);

    await migration.onModuleInit();

    expect(warn).not.toHaveBeenCalled();
  });

  // Dirent.isDirectory() is false for a symlink, and an operator who moved a large profile onto
  // another volume has one here. Renaming the link is what keeps that install working.
  it('renames a symlinked legacy directory, leaving its target where it is', async () => {
    const relocated = path.join(tmpRoot, 'elsewhere', 'alice-profile');
    seed(relocated, 'wwjs-alice');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.symlinkSync(relocated, path.join(sessionsDir, 'session-alice'));

    await buildMigration([{ id: ALICE_ID, name: 'alice' }]).onModuleInit();

    expect(fs.readlinkSync(path.join(sessionsDir, `session-${ALICE_ID}`))).toBe(relocated);
    expect(markerAt(path.join(sessionsDir, `session-${ALICE_ID}`))).toBe('wwjs-alice');
    expect(markerAt(relocated)).toBe('wwjs-alice');
  });

  // A base directory that exists but cannot be listed (EACCES after the container user changed,
  // ENOTDIR when the path is a file) skips EVERY session under it, so it must not look like a fresh
  // install: without a line here the sessions come back at a QR with nothing to explain it.
  it('warns when the base directory exists but cannot be listed', async () => {
    fs.writeFileSync(sessionsDir, 'not a directory');
    const migration = buildMigration([{ id: ALICE_ID, name: 'alice' }]);
    const warn = jest
      .spyOn((migration as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);

    await migration.onModuleInit();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('whatsapp-web.js'),
      expect.objectContaining({ action: 'auth_dir_migration_unreadable' }),
    );
  });

  // Not reachable through the API (CreateSessionDto restricts names), but a row written outside the
  // app can carry one: path.join + basename would resolve `../alice` onto alice's own directory and
  // rename her login onto the crafted row's id.
  it('never lets a traversal name reach the rename, leaving the session it points at alone', async () => {
    seed(path.join(baileysDir, 'alice'), 'baileys-alice');

    await buildMigration([
      { id: BOB_ID, name: '../alice' },
      { id: ALICE_ID, name: 'alice' },
    ]).onModuleInit();

    expect(markerAt(path.join(baileysDir, ALICE_ID))).toBe('baileys-alice');
    expect(fs.existsSync(path.join(baileysDir, BOB_ID))).toBe(false);
  });

  it('skips the query and the filesystem entirely when there are no sessions', async () => {
    seed(path.join(sessionsDir, 'session-orphan'), 'orphan');

    await buildMigration([]).onModuleInit();

    expect(fs.readdirSync(sessionsDir)).toEqual(['session-orphan']);
  });
});
