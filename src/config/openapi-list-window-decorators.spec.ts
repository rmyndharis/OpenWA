import { DECORATORS } from '@nestjs/swagger';
import { AuditController } from '../modules/audit/audit.controller';
import { ChannelController } from '../modules/channel/channel.controller';
import { MessageController } from '../modules/message/message.controller';

/**
 * These handlers read `limit` and `offset` with parseInt, so the parameters are integer counts. Published as
 * `number`, a generated Go or Java client types them as floating point.
 */
describe('list routes publish limit and offset as integers', () => {
  const typeOf = (handler: object, name: string): unknown =>
    (Reflect.getMetadata(DECORATORS.API_PARAMETERS, handler) as Array<{ name: string; type?: unknown }>).find(
      p => p.name === name,
    )?.type;

  /* eslint-disable @typescript-eslint/unbound-method -- reading route metadata, not invoking */
  it.each([
    ['GET /api/audit', AuditController.prototype.findAll, ['limit', 'offset']],
    ['GET /sessions/{sessionId}/messages', MessageController.prototype.getMessages, ['limit', 'offset']],
    ['GET /sessions/{sessionId}/messages/{chatId}/history', MessageController.prototype.getChatHistory, ['limit']],
    ['GET /sessions/{sessionId}/channels/{channelId}/messages', ChannelController.prototype.getMessages, ['limit']],
  ])('%s', (_route, handler, names) => {
    for (const name of names) expect([name, typeOf(handler, name)]).toEqual([name, 'integer']);
  });
  /* eslint-enable @typescript-eslint/unbound-method */
});
