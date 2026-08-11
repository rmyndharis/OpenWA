import { Boom } from '@hapi/boom';
import { refusedStatusCode, mapServerRefusal } from './baileys-groups';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

/**
 * `refusedStatusCode` decides whether a Baileys failure was a SERVER refusal (map to 403/404) or a
 * transport death (must propagate). Every case here is built with a real `Boom`, because that is
 * what Baileys throws and because the shape is the whole point: Boom's constructor destructures
 * `data = null`, so no Boom ever carries `data === undefined`.
 *
 * The pre-existing fixtures used `Object.assign(new Error(...), { output })` with no `data` at all,
 * which is why a transport death appeared to propagate in tests while a real one did not.
 */
describe('refusedStatusCode', () => {
  it('reads a server refusal from the numeric data assertNodeErrorFree attaches', () => {
    // query() runs assertNodeErrorFree before returning, and it throws `data: +errNode.attrs.code`.
    expect(refusedStatusCode(new Boom('forbidden', { data: 403 }))).toBe(403);
    expect(refusedStatusCode(new Boom('gone', { data: 410 }))).toBe(410);
  });

  it.each([
    ['Connection Closed', 428],
    ['Timed Out', 408],
  ])('treats a transport death (%s) as unclassified, so it propagates', (message, statusCode) => {
    // A real Boom: no server error node, and `data` defaulted to null by the constructor.
    const err = new Boom(message, { statusCode });
    expect(err.data).toBeNull();
    expect(refusedStatusCode(err)).toBeUndefined();
  });

  it('treats an unanswered query as unclassified rather than a 500-coded refusal', () => {
    // extractGroupMetadata(undefined) — `data: result` with result undefined, normalised to null.
    const err = new Boom('Invalid group metadata response: missing <group> node', { data: undefined });
    expect(refusedStatusCode(err)).toBeUndefined();
  });

  it('ignores a non-Boom failure entirely', () => {
    expect(refusedStatusCode(new TypeError('Cannot read properties of undefined'))).toBeUndefined();
    expect(refusedStatusCode(undefined)).toBeUndefined();
  });
});

describe('mapServerRefusal', () => {
  it('maps a server refusal to EngineRefusedError', async () => {
    await expect(
      mapServerRefusal('Setting the group subject', () => Promise.reject(new Boom('forbidden', { data: 403 }))),
    ).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('lets a dead socket through untouched instead of calling it a permissions problem', async () => {
    const connectionClosed = new Boom('Connection Closed', { statusCode: 428 });
    await expect(mapServerRefusal('Setting the group subject', () => Promise.reject(connectionClosed))).rejects.toBe(
      connectionClosed,
    );
  });

  it('lets an unanswered query through untouched', async () => {
    const noAnswer = new Boom('Invalid group metadata response: missing <group> node', { data: undefined });
    await expect(mapServerRefusal('Setting the group subject', () => Promise.reject(noAnswer))).rejects.toBe(noAnswer);
  });
});
