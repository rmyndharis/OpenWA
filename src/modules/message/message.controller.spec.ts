import { StreamableFile } from '@nestjs/common';
import { RESPONSE_PASSTHROUGH_METADATA } from '@nestjs/common/constants';
import { MessageController } from './message.controller';
import type { MessageService } from './message.service';
import type { BulkMessageService } from './bulk-message.service';
import type { Response } from 'express';

/**
 * `getChatMedia` serves third-party bytes from the API origin. The route shape, the roles and the
 * status codes are already held by the OpenAPI snapshot and the route-fence gates; the two headers
 * that keep those bytes inert in a browser were held by nothing — deleting either line from the
 * controller passed every suite in the repo.
 */
describe('MessageController — stored media download', () => {
  const getChatMedia = jest.fn().mockResolvedValue({ buffer: Buffer.from('GIF89a'), mimetype: 'image/gif' });
  const controller = new MessageController(
    { getChatMedia } as unknown as MessageService,
    {} as unknown as BulkMessageService,
  );

  /**
   * Express merges the object form of `res.set` into the header bag, so accumulating is both closer
   * to the real thing than recording the last call and independent of how many calls the handler
   * splits its headers across.
   */
  const mediaResponseHeaders = async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};
    const res = { set: (fields: Record<string, string>) => Object.assign(headers, fields) } as unknown as Response;
    await controller.getChatMedia('session-1', '628123@c.us', 'msg-1', res);
    return headers;
  };

  it('sends nosniff, so a wrong Content-Type cannot be re-interpreted as active content', async () => {
    expect((await mediaResponseHeaders())['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sends the media as an attachment, so it is never rendered on the API origin', async () => {
    expect((await mediaResponseHeaders())['Content-Disposition']).toBe('attachment');
  });

  /**
   * The headers above are set on the response object directly, so they survive a handler that sends
   * no body at all — a `404` with a perfect `Content-Disposition` would satisfy both. What actually
   * carries the bytes is the returned `StreamableFile`, and Nest only sends that when the response
   * parameter is declared passthrough: without it Nest treats the handler as having taken the
   * response over and discards the return value entirely. Both halves are asserted here so the pair
   * above cannot end up describing a response that is never sent.
   *
   * Nest records the flag under its own metadata key rather than in the route arguments, and only
   * when it is truthy — so reading it back is what distinguishes `@Res({ passthrough: true })` from
   * a bare `@Res()`.
   */
  it('declares the response passthrough, so Nest sends the returned file rather than discarding it', () => {
    expect(Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, MessageController, 'getChatMedia')).toBe(true);
  });

  it('returns the stored bytes as the response body', async () => {
    const res = { set: () => undefined } as unknown as Response;

    const body = await controller.getChatMedia('session-1', '628123@c.us', 'msg-1', res);

    expect(body).toBeInstanceOf(StreamableFile);
    expect(body.getStream().read()).toEqual(Buffer.from('GIF89a'));
  });
});

/**
 * `inlineMedia` is an OPT-OUT, unlike every other boolean on this controller, so the parse reads the
 * same string pair the other way round. Inverting it would quietly strip media from every default
 * read, which no other suite would notice: the service takes a boolean and cannot tell who set it.
 */
describe('MessageController - inlineMedia is opt-out', () => {
  const getMessages = jest.fn().mockResolvedValue({ messages: [], total: 0 });
  const controller = new MessageController(
    { getMessages } as unknown as MessageService,
    {} as unknown as BulkMessageService,
  );

  const inlineMediaFor = async (raw?: string): Promise<boolean> => {
    getMessages.mockClear();
    await controller.getMessages('session-1', undefined, undefined, undefined, undefined, undefined, raw);
    const [, options] = getMessages.mock.calls[0] as [string, { inlineMedia: boolean }];
    return options.inlineMedia;
  };

  it.each([undefined, 'true', '1', '', 'no', 'False'])('keeps media inline for %p', async raw => {
    expect(await inlineMediaFor(raw)).toBe(true);
  });

  it.each(['false', '0'])('omits media for %p', async raw => {
    expect(await inlineMediaFor(raw)).toBe(false);
  });
});
