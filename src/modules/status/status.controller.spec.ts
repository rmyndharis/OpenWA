import { StreamableFile } from '@nestjs/common';
import { Readable } from 'stream';
import { RESPONSE_PASSTHROUGH_METADATA } from '@nestjs/common/constants';
import { StatusController } from './status.controller';
import type { StatusService } from './status.service';
import type { Response } from 'express';

/**
 * `getStatusMedia` serves third-party bytes from the API origin, exactly like the chat-media route
 * (message.controller.spec.ts holds that pair). StatusService already reduces the Content-Type to
 * an inert set, but defense is layered: attachment means even a mimetype mistake can never render
 * as active content here. The header was held by nothing — deleting the line passed every suite.
 */
describe('StatusController — stored status media download', () => {
  // A fresh stream per call: the service hands over an opened file, which can be read once.
  const getStatusMedia = jest.fn(() =>
    Promise.resolve({ stream: Readable.from([Buffer.from('GIF89a')]), size: 6, mimetype: 'image/gif' }),
  );
  const controller = new StatusController({ getStatusMedia } as unknown as StatusService);

  // Express merges the object form of `res.set` into the header bag; accumulating mirrors that
  // regardless of how many calls the handler splits its headers across.
  const mediaResponseHeaders = async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};
    const res = { set: (fields: Record<string, string>) => Object.assign(headers, fields) } as unknown as Response;
    await controller.getStatusMedia('session-1', 'falsestatus@status', res);
    return headers;
  };

  it('sends nosniff, so a wrong Content-Type cannot be re-interpreted as active content', async () => {
    expect((await mediaResponseHeaders())['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sends the media as an attachment, so it is never rendered on the API origin', async () => {
    expect((await mediaResponseHeaders())['Content-Disposition']).toBe('attachment');
  });

  // The headers are set on the response object directly; the bytes travel in the returned
  // StreamableFile, which Nest only sends for a passthrough-declared response parameter.
  it('declares the response passthrough, so Nest sends the returned file rather than discarding it', () => {
    expect(Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, StatusController, 'getStatusMedia')).toBe(true);
  });

  it('returns the stored bytes as the response body', async () => {
    const res = { set: () => undefined } as unknown as Response;

    const body = await controller.getStatusMedia('session-1', 'falsestatus@status', res);

    expect(body).toBeInstanceOf(StreamableFile);
    expect(body.getHeaders().length).toBe(6);
    expect(Buffer.concat(await body.getStream().toArray())).toEqual(Buffer.from('GIF89a'));
  });
});
