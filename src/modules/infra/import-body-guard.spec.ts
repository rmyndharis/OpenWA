import * as http from 'http';
import { constants as bufferConstants } from 'buffer';
import { once } from 'events';
import { text } from 'stream/consumers';
import type { AddressInfo } from 'net';
import express from 'express';
import { HttpException } from '@nestjs/common';
import { refuseUnrestorableImport, refuseUnrestorableImportBody } from './import-body-guard';

// The module object the guard reads: a namespace import would be a copy, which cannot be spied on.
const v8 = jest.requireActual<typeof import('v8')>('v8');

// A restore is one JSON body, decoded and parsed whole before the route runs. With the body cap raised
// for a large backup, as the migration guide has the operator do, a 483 MB body exhausted a 1 GiB heap
// while it was parsed and took the gateway down.
describe('the body guard of POST /api/infra/import-data', () => {
  const MB = 1024 * 1024;
  const BODY_CAP = 256 * MB;
  let server: http.Server;
  let port: number;
  let reached: string[];

  beforeEach(async () => {
    reached = [];
    const app = express();
    // As the gateway does: a caller is known by its key before any guard has run.
    app.use(refuseUnrestorableImport(BODY_CAP, req => req.headers['x-api-key'] === 'a-known-key'));
    app.use((req, res) => {
      reached.push(`${req.method} ${req.path}`);
      req.resume();
      res.json({ reached: true });
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const freeHeap = (bytes: number): void => {
    const heap = v8.getHeapStatistics();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue({ ...heap, heap_size_limit: heap.used_heap_size + bytes });
  };

  /** Declares a body and sends none of it: the answer must not wait for one. */
  const declare = async (
    headers: http.OutgoingHttpHeaders,
    path = '/api/infra/import-data',
    method = 'POST',
  ): Promise<{ status?: number; connection?: string; body: Record<string, unknown> }> => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'X-API-Key': 'a-known-key', ...headers },
      agent: false,
    });
    request.on('error', () => undefined);
    request.flushHeaders();
    const [response] = (await once(request, 'response')) as [http.IncomingMessage];
    const body = JSON.parse(await text(response)) as Record<string, unknown>;
    request.destroy();
    return { status: response.statusCode, connection: response.headers.connection, body };
  };

  it('refuses a backup whose restore would not fit the free heap, before reading it, and names the limit', async () => {
    freeHeap(900 * MB);

    const refused = await declare({ 'Content-Type': 'application/json', 'Content-Length': 483 * MB });

    expect(refused).toMatchObject({
      status: 413,
      connection: 'close',
      body: { statusCode: 413, code: 'IMPORT_TOO_LARGE' },
    });
    expect(refused.body.message).toBe(
      `The backup is ${483 * MB} bytes, and with the memory this process has free it can restore at most ` +
        `${360 * MB}. Raise the memory of the process, or restore a copy made by scripts/backup.sh with ` +
        'scripts/restore.sh instead.',
    );
    expect(reached).toEqual([]);
  });

  it('lets through a backup that fits, and one of the size the heap allows exactly', async () => {
    freeHeap(900 * MB);

    await expect(declare({ 'Content-Length': 268 * MB })).resolves.toMatchObject({ status: 200 });
    await expect(declare({ 'Content-Length': 360 * MB })).resolves.toMatchObject({ status: 200 });
    await expect(declare({ 'Content-Length': 360 * MB + 1 })).resolves.toMatchObject({ status: 413 });
  });

  it('refuses a backup longer than the longest string, whatever the heap', async () => {
    freeHeap(64 * 1024 * MB);

    const refused = await declare({ 'Content-Length': bufferConstants.MAX_STRING_LENGTH + 1 });

    expect(refused.status).toBe(413);
    expect(refused.body.message).toContain(`at most ${bufferConstants.MAX_STRING_LENGTH}.`);
    await expect(declare({ 'Content-Length': bufferConstants.MAX_STRING_LENGTH })).resolves.toMatchObject({
      status: 200,
    });
  });

  it('refuses a caller it does not know above the default body cap, at the same size whatever the heap', async () => {
    // Where the refusal starts would otherwise tell a caller without a key how much memory is free.
    for (const free of [64 * 1024 * MB, 900 * MB, 1 * MB]) {
      freeHeap(free);
      const anonymous = { 'X-API-Key': 'not-a-key' };

      await expect(declare({ ...anonymous, 'Content-Length': 25 * MB })).resolves.toMatchObject({ status: 200 });
      const refused = await declare({ ...anonymous, 'Content-Length': 25 * MB + 1 });

      expect(refused).toMatchObject({
        status: 413,
        connection: 'close',
        body: { statusCode: 413, error: 'Payload Too Large', code: 'IMPORT_TOO_LARGE' },
      });
      expect(refused.body.message).toBe(
        `A backup above ${25 * MB} bytes is read only from a caller with an admin API key ` +
          'that no session or chat restriction limits.',
      );
    }
    expect(reached).toHaveLength(3);
  });

  it('never refuses a backup within the default body cap, which has always been accepted', async () => {
    // What the heap reports as used includes what a collection would free.
    freeHeap(1 * MB);

    await expect(declare({ 'Content-Length': 25 * MB })).resolves.toMatchObject({ status: 200 });
    await expect(declare({ 'Content-Length': 25 * MB + 1 })).resolves.toMatchObject({ status: 413 });
  });

  it('takes a body that declares no length to be as long as the body cap lets it be, and says so', async () => {
    freeHeap(500 * MB);
    await expect(declare({ 'Transfer-Encoding': 'chunked' })).resolves.toMatchObject({
      status: 413,
      connection: 'close',
      body: {
        statusCode: 413,
        code: 'IMPORT_TOO_LARGE',
        message:
          'The backup was sent without a Content-Length, so its size cannot be checked against the memory ' +
          'this process has free before it is read. Send it with its length: curl --data-binary @file does.',
      },
    });

    freeHeap(900 * MB);
    await expect(declare({ 'Transfer-Encoding': 'chunked' })).resolves.toMatchObject({ status: 200 });
  });

  it('guards the import route alone, however its path is written', async () => {
    freeHeap(1 * MB);
    const large = { 'Content-Length': 400 * MB };

    await expect(declare(large, '/api/infra/import-data/')).resolves.toMatchObject({ status: 413 });
    await expect(declare(large, '/API/Infra/Import-Data?force=true')).resolves.toMatchObject({ status: 413 });
    await expect(declare(large, '/api/infra/import-data', 'PUT')).resolves.toMatchObject({ status: 200 });
    await expect(declare(large, '/api/infra/import-data-other')).resolves.toMatchObject({ status: 200 });
    await expect(declare(large, '/api/sessions/s1/messages/send-image')).resolves.toMatchObject({ status: 200 });
  });
});

// One character above U+00FF anywhere in a body makes the whole decoded string two bytes a character, so
// a backup with an emoji in it needs about one more byte of heap per byte than its length suggests: on a
// 1 GiB heap a 402 MB backup all in ASCII was restored, and the same file with one emoji ended the process.
describe('the check of POST /api/infra/import-data on the body as read', () => {
  const MB = 1024 * 1024;
  const EMOJI = String.fromCodePoint(0x1f60a);
  const importRequest = (path = '/api/infra/import-data', method = 'POST') => ({ method, path }) as express.Request;

  /** A body of exactly `bytes`, all ASCII but for what `odd` puts at its start. */
  const body = (bytes: number, odd = ''): Buffer => {
    const buf = Buffer.alloc(bytes, 'a');
    buf.write(odd);
    return buf;
  };

  afterEach(() => jest.restoreAllMocks());

  const freeHeap = (bytes: number): void => {
    const heap = v8.getHeapStatistics();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue({ ...heap, heap_size_limit: heap.used_heap_size + bytes });
  };

  it('refuses a body with a character outside Latin-1 above the free heap divided by 4, and names both figures', () => {
    freeHeap(112 * MB);

    const refusal = (() => {
      try {
        refuseUnrestorableImportBody(importRequest(), body(30 * MB, EMOJI));
      } catch (error) {
        return error as HttpException;
      }
    })();

    expect(refusal).toBeInstanceOf(HttpException);
    expect(refusal?.getStatus()).toBe(413);
    expect(refusal?.getResponse()).toEqual({
      statusCode: 413,
      error: 'Payload Too Large',
      code: 'IMPORT_TOO_LARGE',
      message:
        `The backup is ${30 * MB} bytes and holds characters outside Latin-1, so a restore keeps its text at ` +
        `two bytes a character: with the memory this process has free it can restore at most ${28 * MB} bytes of ` +
        'such a backup. Raise the memory of the process, or restore a copy made by scripts/backup.sh with ' +
        'scripts/restore.sh instead.',
    });
  });

  it('lets through the same body all in ASCII, and one that is not of the size the heap allows exactly', () => {
    freeHeap(112 * MB);

    expect(() => refuseUnrestorableImportBody(importRequest(), body(30 * MB))).not.toThrow();
    expect(() => refuseUnrestorableImportBody(importRequest(), body(28 * MB, EMOJI))).not.toThrow();
    expect(() => refuseUnrestorableImportBody(importRequest(), body(28 * MB + 1, EMOJI))).toThrow(HttpException);
    // A typographic apostrophe, as phone keyboards type it, counts the same as an emoji.
    expect(() =>
      refuseUnrestorableImportBody(importRequest(), body(28 * MB + 1, String.fromCodePoint(0x2019))),
    ).toThrow(HttpException);
  });

  it('weighs a body whose characters all fit Latin-1 as ASCII, whose string V8 keeps at one byte a character', () => {
    freeHeap(112 * MB);

    // Accented text, the first and the last character of the Latin-1 range above ASCII.
    for (const accented of ['é', 'ß ã ñ ü', String.fromCodePoint(0x80), String.fromCodePoint(0xff)]) {
      expect(() => refuseUnrestorableImportBody(importRequest(), body(30 * MB, accented))).not.toThrow();
    }
    // The first character past it, and a byte that is not UTF-8, which decodes to U+FFFD.
    const invalid = body(30 * MB);
    invalid[0] = 0xe9;
    for (const wide of [body(30 * MB, String.fromCodePoint(0x100)), invalid]) {
      expect(() => refuseUnrestorableImportBody(importRequest(), wide)).toThrow(HttpException);
    }
  });

  // Two restores sent together both pass the first look, taken before either is parsed. body-parser decodes and
  // parses in the turn it verifies, so the second look at the later one sees what the earlier one holds by then.
  it('looks again at an all-ASCII body as read, against the heap free at that moment', () => {
    freeHeap(112 * MB);

    const refusal = (() => {
      try {
        refuseUnrestorableImportBody(importRequest(), body(45 * MB));
      } catch (error) {
        return error as HttpException;
      }
    })();

    expect(refusal?.getStatus()).toBe(413);
    expect(refusal?.getResponse()).toMatchObject({
      code: 'IMPORT_TOO_LARGE',
      message:
        `The backup is ${45 * MB} bytes, and with the memory this process has free it can restore at most ` +
        `${Math.floor((112 * MB) / 2.5)}. Raise the memory of the process, or restore a copy made by ` +
        'scripts/backup.sh with scripts/restore.sh instead.',
    });
  });

  it('never refuses a body within the default body cap, and looks at the import route alone', () => {
    freeHeap(1 * MB);

    expect(() => refuseUnrestorableImportBody(importRequest(), body(25 * MB, EMOJI))).not.toThrow();
    expect(() => refuseUnrestorableImportBody(importRequest('/API/Infra/Import-Data/'), body(26 * MB, EMOJI))).toThrow(
      HttpException,
    );
    for (const other of [importRequest('/api/infra/import-data', 'PUT'), importRequest('/api/echo')]) {
      expect(() => refuseUnrestorableImportBody(other, body(26 * MB, EMOJI))).not.toThrow();
    }
  });
});
