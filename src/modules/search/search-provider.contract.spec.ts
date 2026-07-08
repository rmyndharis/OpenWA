import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AddMessagesFts1782400000000 } from '../../database/migrations/1782400000000-AddMessagesFts';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { BuiltInFtsProvider } from './providers/builtin-fts.provider';
import type { SearchProvider } from './search.types';

/** A seed message the contract harness asks the provider-under-test to index. */
type ContractSeedMessage = { body: string; sessionId: string };

/** Environment a provider-under-test exposes to the contract harness. */
interface ContractEnv {
  provider: SearchProvider;
  /** Index the given messages (same bodies/sessionIds the harness asserts against). */
  seed: (messages: ContractSeedMessage[]) => Promise<void>;
}

/**
 * Contract every SearchProvider must satisfy. Run inside a `describe` from a provider's own spec
 * (Spec 2's Meilisearch plugin reuses this as its review gate):
 *
 *   describe('MyProvider', () => { runProviderContract(async () => ({ provider, seed })); });
 *
 * The harness seeds a fixed 3-message set (two sessions, one shared term `hello`, one session-unique
 * `goodbye`) in `beforeEach`, then asserts the provider's `search`/`health` contract. `makeProvider`
 * is invoked fresh per test so each case starts from a clean index.
 */
export function runProviderContract(makeProvider: () => Promise<ContractEnv>): void {
  let provider: SearchProvider;
  let seed: (messages: ContractSeedMessage[]) => Promise<void>;

  beforeEach(async () => {
    const env = await makeProvider();
    provider = env.provider;
    seed = env.seed;
    await seed([
      { body: 'hello world', sessionId: 's1' },
      { body: 'goodbye world', sessionId: 's1' },
      { body: 'hello other', sessionId: 's2' },
    ]);
  });

  it('returns matching hits with a snippet, total, and provider id', async () => {
    const q = 'hello';
    const res = await provider.search({ q, limit: 10 });
    expect(res.provider).toBe(provider.id);
    expect(res.hits.length).toBe(2);
    // Snippet must actually reflect the query term — `length >= 0` is trivially true.
    expect(res.hits.every(h => h.snippet.toLowerCase().includes(q.toLowerCase()))).toBe(true);
    expect(res.total).toBeGreaterThanOrEqual(2);
  });

  it('honors sessionIds scoping', async () => {
    const res = await provider.search({ q: 'hello', sessionIds: ['s2'] });
    // The seed puts `hello other` in s2, so this MUST yield ≥1 hit — otherwise the `every`
    // predicate below is vacuously true on an empty hit set (zero-hit escape hatch).
    expect(res.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.hits.every(h => h.sessionId === 's2')).toBe(true);
  });

  it('returns empty for no matches', async () => {
    const res = await provider.search({ q: 'zzzz' });
    expect(res.hits).toEqual([]);
    // For pagination correctness, total === 0 when no hits is part of the contract.
    expect(res.total).toBe(0);
  });

  it('reports health', async () => {
    const h = await provider.health();
    expect(typeof h.ok).toBe('boolean');
  });
}

// Wire the built-in provider into the contract: proves the harness is satisfiable and gives Spec 2's
// plugin a concrete example. The seed mirrors the FTS provider spec's message shape (Task 6).
describe('BuiltInFtsProvider satisfies the SearchProvider contract', () => {
  let ds: DataSource;

  afterEach(async () => {
    if (ds && ds.isInitialized) {
      await ds.destroy();
    }
  });

  runProviderContract(async () => {
    ds = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    await new AddMessagesFts1782400000000().up(ds.createQueryRunner());
    const provider = new BuiltInFtsProvider(ds);
    const seed = async (messages: ContractSeedMessage[]): Promise<void> => {
      await ds.getRepository(Message).insert(
        messages.map(m => ({
          sessionId: m.sessionId,
          body: m.body,
          chatId: 'c',
          from: 'a@c.us',
          to: 'dest@c.us',
          type: 'text',
          direction: MessageDirection.OUTGOING,
          timestamp: 1,
        })),
      );
    };
    return { provider, seed };
  });
});
