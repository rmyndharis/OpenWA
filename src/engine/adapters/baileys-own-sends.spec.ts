import { OwnSendRegistry } from './baileys-own-sends';

/**
 * The adapter is the only party that knows which `fromMe` messages it sent itself. Baileys echoes
 * every API send back through `messages.upsert` tagged `append`, and WhatsApp replays messages the
 * account typed on its phone during an outage through the same tag, so the id is the only thing
 * that tells the two apart.
 */
describe('OwnSendRegistry', () => {
  it('consumes a remembered id exactly once', () => {
    const registry = new OwnSendRegistry();
    registry.remember('A');
    expect(registry.consume('A')).toBe(true);
    expect(registry.consume('A')).toBe(false);
  });

  it('does not claim an id it never sent', () => {
    const registry = new OwnSendRegistry();
    expect(registry.consume('PHONE')).toBe(false);
    expect(registry.consume(undefined)).toBe(false);
    expect(registry.consume(null)).toBe(false);
  });

  it('ignores an empty id rather than remembering it', () => {
    const registry = new OwnSendRegistry();
    registry.remember(undefined);
    registry.remember(null);
    registry.remember('');
    expect(registry.size).toBe(0);
  });

  // An echo that never arrives (the library option off, a send whose id could not be read back)
  // would otherwise leave its id behind forever on a gateway that runs for months.
  it('forgets the oldest ids once the cap is reached', () => {
    const registry = new OwnSendRegistry(3);
    registry.remember('A');
    registry.remember('B');
    registry.remember('C');
    registry.remember('D');
    expect(registry.size).toBe(3);
    expect(registry.consume('A')).toBe(false);
    expect(registry.consume('D')).toBe(true);
  });
});
