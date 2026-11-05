import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Session } from './entities/session.entity';
import { SessionEngineControls, StopMarks } from './session-engine-controls';
import { SessionService } from './session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';

const HINT = 'session routes take the session id, not its name';

/**
 * The session routes used to refuse anything but a UUID, which told a caller who sent the session name that an id was
 * expected. A name is a safe key now and reaches the lookup, so the 404 for an id no row has carries that signal.
 */
describe('a request for a session id no row has', () => {
  let ds: DataSource;
  let service: SessionService;
  let controls: SessionEngineControls;

  beforeAll(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Session], synchronize: true });
    await ds.initialize();
    const attach = { attachTo: (s: Session) => s } as never;
    const unused = {} as never;
    service = new SessionService(
      ds.getRepository(Session),
      unused, // messages
      ds,
      new EngineRegistry(),
      unused, // watchdog
      attach, // session errors
      attach, // session restrictions
      unused, // presence
      unused, // hooks
      unused, // engine lifecycle
      unused, // lid mappings
    );
    controls = new SessionEngineControls({
      sessionRepository: ds.getRepository(Session),
      stoppingSessions: new StopMarks(),
    } as never);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  const lookups: Array<[string, (id: string) => Promise<unknown>]> = [
    ['findOne', id => service.findOne(id)],
    ['updateConfig', id => service.updateConfig(id, { autoRejectCalls: true })],
    ['the lifecycle stop', id => controls.stop(id)],
  ];

  it.each(lookups)('%s tells a caller who sent a name that the routes take the id', async (_name, lookup) => {
    const error = await lookup('my-bot').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe(`Session with id 'my-bot' not found; ${HINT}`);
  });

  it.each(lookups)('%s keeps the text it always had for a UUID', async (_name, lookup) => {
    const id = randomUUID();

    const error = await lookup(id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe(`Session with id '${id}' not found`);
  });
});
