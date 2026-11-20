import { BadRequestException } from '@nestjs/common';
import { BulkMessageService } from './bulk-message.service';

// A bulk item's media URL is held to the single-send rule at batch creation, as it is again once rendered: a URL with
// a user name or a password is refused with 400 where the batch is created, not item by item later.
describe('BulkMessageService: a media item URL with credentials', () => {
  const assertItemContent = Reflect.get(BulkMessageService.prototype, 'assertItemContent') as (
    this: unknown,
    type: string,
    content: unknown,
    beforeRender?: boolean,
  ) => void;
  const check = (type: string, url: string, beforeRender = false): void =>
    assertItemContent.call({}, type, { [type]: { url } }, beforeRender);

  it.each(['image', 'video', 'audio', 'document'])('refuses it on a %s item, before and after rendering', type => {
    const url = 'https://ops:s3cr3t-token@example.com/file';

    for (const beforeRender of [true, false]) {
      expect(() => check(type, url, beforeRender)).toThrow(BadRequestException);
      expect(() => check(type, url, beforeRender)).toThrow(
        `content.${type}.url must not contain credentials (userinfo)`,
      );
    }
  });

  it('does not repeat the credentials in the refusal', () => {
    expect(() => check('image', 'https://ops:s3cr3t-token@example.com/a.jpg')).not.toThrow(/s3cr3t-token/);
  });

  it('accepts a URL without credentials, and leaves a placeholder URL to the rendered check', () => {
    expect(() => check('image', 'https://example.com/a.jpg')).not.toThrow();
    expect(() => check('image', 'https://{{user}}@example.com/a.jpg', true)).not.toThrow();
  });
});
