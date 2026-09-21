import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';
import { UpdateSessionProxyDto } from './session-proxy.dto';
import { CreateSessionDto } from './create-session.dto';

/**
 * A proxy URL whose credentials carry a percent that begins no escape passes `@IsUrl` and `new URL()`,
 * and only throws later, inside whichever library decodes it. Both routes that accept one must refuse
 * it at the boundary, so this drives the real global pipe rather than the validator alone.
 */
describe('proxy credential escapes on both routes that accept a proxy URL', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const through = (metatype: unknown, value: object): Promise<unknown> =>
    pipe.transform(value, { type: 'body', metatype: metatype as never });

  const BAD = 'http://u:pa%ss@proxy.local:8080';

  /** The per-field messages the pipe collects, which is where a constraint's own wording lands. */
  const messagesFrom = async (metatype: unknown, value: object): Promise<string[]> => {
    try {
      await through(metatype, value);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as { message?: string[] };
      return body.message ?? [];
    }
    throw new Error('expected the pipe to reject');
  };

  it('refuses it on the proxy update route, naming the escape', async () => {
    expect(await messagesFrom(UpdateSessionProxyDto, { proxyUrl: BAD })).toEqual([
      expect.stringContaining('invalid percent-escape'),
    ]);
  });

  it('refuses it on the session create route', async () => {
    expect(await messagesFrom(CreateSessionDto, { name: 'sess', proxyUrl: BAD })).toEqual([
      expect.stringContaining('invalid percent-escape'),
    ]);
  });

  it('accepts an escaped percent, an encoded credential and no credentials at all', async () => {
    await expect(
      through(UpdateSessionProxyDto, { proxyUrl: 'http://u:pa%25ss@proxy.local:8080' }),
    ).resolves.toBeDefined();
    await expect(
      through(UpdateSessionProxyDto, { proxyUrl: 'socks5://user:p%40ss@proxy.local:1080' }),
    ).resolves.toBeDefined();
    await expect(through(UpdateSessionProxyDto, { proxyUrl: 'http://proxy.local:8080' })).resolves.toBeDefined();
  });

  it('leaves clearing the proxy with null alone', async () => {
    await expect(through(UpdateSessionProxyDto, { proxyUrl: null })).resolves.toBeDefined();
  });
});
