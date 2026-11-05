import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { of } from 'rxjs';
import { FORWARD_BUFFER_LIMIT_BYTES, SessionProxyInterceptor } from './session-proxy.interceptor';

const MIB = 1024 * 1024;
const SID = '3f8d1c2a-4b6e-4f0d-9a7c-2e5b8d1f6a3c';

/** `length` bytes of a repeating pattern, starting at `offset` of the whole body, so a relay that drops or repeats a chunk shows. */
const pattern = (offset: number, length: number): Buffer => {
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) out[i] = (offset + i) % 251;
  return out;
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => (resolve = res));
  return { promise, resolve };
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** What the promise settles to, or 'timeout' when it takes longer than `ms`; the timer does not outlive the call. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>(resolve => (timer = setTimeout(resolve, ms, 'timeout'))),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A node that does not own the session relays a download from the owner that does. The owner streams stored media,
 * so the relay must not hold the whole file: it holds a bounded amount and passes the rest on as it arrives, however
 * many downloads run at once. These run a real owner, the real interceptor on an Express app, and a real client.
 */
describe('SessionProxyInterceptor relaying an answer larger than it holds', () => {
  const CEILING = FORWARD_BUFFER_LIMIT_BYTES;
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  const listen = async (server: http.Server): Promise<string> => {
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const startOwner = (handler: http.RequestListener): Promise<string> => listen(http.createServer(handler));

  /** The node the client talks to: the real interceptor, forwarding to `ownerUrl`, on an Express app. */
  const startNode = async (ownerUrl: string, timeoutMs = 30_000) => {
    const interceptor = new SessionProxyInterceptor(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: SID,
          nodeId: 'peer-node',
          nodeUrl: ownerUrl,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      } as never,
      { nodeId: 'me', nodeUrl: 'http://127.0.0.1:1' } as never,
      { get: jest.fn().mockReturnValue(timeoutMs) } as never,
    );
    const warn = jest
      .spyOn((interceptor as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const app = express();
    app.get('/api/sessions/:sessionId/media', (req, res, next) => {
      const context = {
        getType: () => 'http',
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      };
      interceptor.intercept(context as never, { handle: () => of('handled-locally') }).then(() => undefined, next);
    });
    const url = await listen(http.createServer(app));
    return { url: `${url}/api/sessions/${SID}/media`, warn };
  };

  /** A client that keeps what it has received so far, and says when `bytes` of it have arrived. */
  const download = (url: string) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const waiting: Array<() => void> = [];
    const request = http.get(url);
    let answer!: http.IncomingMessage;
    const headers = new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', res => resolve((answer = res)));
    });
    const finished = headers.then(
      res =>
        new Promise<{ body: Buffer; complete: boolean }>(resolve => {
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            received += chunk.length;
            for (const wake of waiting.splice(0)) wake();
          });
          res.on('error', () => undefined);
          res.on('close', () => resolve({ body: Buffer.concat(chunks), complete: res.complete }));
        }),
    );
    finished.catch(() => undefined);
    /** True once `bytes` have arrived, false if they have not within `ms`. */
    const reached = (bytes: number, ms = 3000): Promise<boolean> =>
      new Promise(resolve => {
        const deadline = setTimeout(() => resolve(false), ms);
        const check = (): void => {
          if (received >= bytes) {
            clearTimeout(deadline);
            resolve(true);
          } else {
            waiting.push(check);
          }
        };
        check();
      });
    return { request, headers, finished, reached, response: () => answer };
  };

  it('relays the start of the answer while the owner is still sending, with its length and headers', async () => {
    const total = CEILING + 3 * MIB;
    const sentAtOnce = CEILING + MIB;
    const rest = deferred();
    const owner = await startOwner((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(total) });
      res.write(pattern(0, sentAtOnce));
      void rest.promise.then(() => res.end(pattern(sentAtOnce, total - sentAtOnce)));
    });
    const node = await startNode(owner);

    const client = download(node.url);

    // The owner has not finished, so a relay that waits for the whole body has sent nothing yet.
    expect(await client.reached(CEILING)).toBe(true);
    const res = await client.headers;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(total));
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-openwa-served-by']).toBe('peer-node');
    rest.resolve();

    const { body, complete } = await client.finished;
    expect(complete).toBe(true);
    expect(body.equals(pattern(0, total))).toBe(true);
  });

  it('relays an answer that declares no length as it arrives, and declares none itself', async () => {
    const sentAtOnce = CEILING + MIB;
    const rest = deferred();
    const owner = await startOwner((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(pattern(0, sentAtOnce));
      void rest.promise.then(() => res.end(pattern(sentAtOnce, MIB)));
    });
    const node = await startNode(owner);

    const client = download(node.url);

    expect(await client.reached(CEILING)).toBe(true);
    expect((await client.headers).headers['content-length']).toBeUndefined();
    rest.resolve();
    const { body, complete } = await client.finished;
    expect(complete).toBe(true);
    expect(body.equals(pattern(0, sentAtOnce + MIB))).toBe(true);
  });

  // fetch decodes an encoded body, so the length the owner declared no longer describes the bytes relayed.
  it('declares no length of its own when the owner encoded the answer', async () => {
    const total = CEILING + MIB;
    const owner = await startOwner((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'identity', 'content-length': String(total) });
      res.end(pattern(0, total));
    });
    const node = await startNode(owner);

    const client = download(node.url);
    const { body, complete } = await client.finished;

    expect(complete).toBe(true);
    expect(body.equals(pattern(0, total))).toBe(true);
    expect(client.response().headers['content-length']).toBeUndefined();
  });

  it('keeps sending an answer to a client slower than the forward timeout', async () => {
    const total = CEILING + 3 * MIB;
    const sentAtOnce = CEILING + MIB;
    const rest = deferred();
    const owner = await startOwner((_req, res) => {
      res.writeHead(200, { 'content-length': String(total) });
      res.write(pattern(0, sentAtOnce));
      void rest.promise.then(() => res.end(pattern(sentAtOnce, total - sentAtOnce)));
    });
    const node = await startNode(owner, 1000);

    const client = download(node.url);
    expect(await client.reached(CEILING)).toBe(true);
    (await client.headers).pause();
    await sleep(1500);
    (await client.headers).resume();
    rest.resolve();

    const { body, complete } = await client.finished;
    expect(complete).toBe(true);
    expect(body.equals(pattern(0, total))).toBe(true);
    expect(node.warn).not.toHaveBeenCalled();
  });

  it('cuts the connection, and says so, when the owner breaks off after the answer began', async () => {
    const total = CEILING + 3 * MIB;
    const began = deferred();
    const owner = await startOwner((req, res) => {
      res.writeHead(200, { 'content-length': String(total) });
      res.write(pattern(0, CEILING + MIB));
      // The owner breaks off once the client has the start of the answer, which is when the relay has begun; a fixed
      // delay would break it off before the relay read its first 4 MiB on a loaded machine, and that is a 502.
      void began.promise.then(() => req.socket.destroy());
    });
    const node = await startNode(owner);

    const client = download(node.url);
    expect(await client.reached(CEILING, 10_000)).toBe(true);
    began.resolve();
    const { body, complete } = await client.finished;

    expect(client.response().statusCode).toBe(200);
    expect(complete).toBe(false);
    expect(body.length).toBeLessThan(total);
    expect(node.warn).toHaveBeenCalledWith(
      expect.stringContaining('broke after the answer began'),
      expect.objectContaining({ ownerNodeUrl: owner }),
    );
  });

  it('cancels the request to the owner when the client leaves, without calling it a failure', async () => {
    const gone = deferred();
    const owner = await startOwner((_req, res) => {
      res.writeHead(200, { 'content-length': String(CEILING + 4 * MIB) });
      res.write(pattern(0, CEILING + MIB));
      res.on('close', () => gone.resolve());
    });
    const node = await startNode(owner);

    const client = download(node.url);
    expect(await client.reached(CEILING)).toBe(true);
    client.request.destroy();

    await expect(
      within(
        gone.promise.then(() => 'cancelled'),
        3000,
      ),
    ).resolves.toBe('cancelled');
    expect(node.warn).not.toHaveBeenCalled();
  });

  // The client has everything the owner sent and the owner is silent, so the relay waits for the next chunk. The
  // owner is let go only because the closing response aborts that wait (else its request stays open until the HTTP
  // client's 300 s idle limit), and pipeline reports that wait ending as an AggregateError, not a premature close.
  it('lets a stalled owner go, without calling it a failure, when the client leaves after all it was sent', async () => {
    const gone = deferred();
    const sent = CEILING + MIB;
    const owner = await startOwner((_req, res) => {
      res.writeHead(200, { 'content-length': String(CEILING + 4 * MIB) });
      res.write(pattern(0, sent));
      res.on('close', () => gone.resolve());
    });
    const node = await startNode(owner);

    const client = download(node.url);
    expect(await client.reached(sent, 5000)).toBe(true);
    await sleep(300);
    client.request.destroy();

    await expect(
      within(
        gone.promise.then(() => 'cancelled'),
        3000,
      ),
    ).resolves.toBe('cancelled');
    expect(node.warn).not.toHaveBeenCalled();
  });

  it('lets the owner go, without calling it a failure, when the client left while the answer was being read', async () => {
    const gone = deferred();
    const rest = deferred();
    const owner = await startOwner((_req, res) => {
      res.writeHead(200, { 'content-length': String(2 * CEILING) });
      res.write(pattern(0, MIB));
      res.on('close', () => gone.resolve());
      void rest.promise.then(() => res.write(pattern(MIB, CEILING)));
    });
    const node = await startNode(owner);

    const client = download(node.url);
    await sleep(200);
    client.request.destroy();
    await sleep(200);
    rest.resolve();

    await expect(
      within(
        gone.promise.then(() => 'cancelled'),
        3000,
      ),
    ).resolves.toBe('cancelled');
    expect(node.warn).not.toHaveBeenCalled();
  });

  it('still answers a small body whole, with the length Express computes', async () => {
    const owner = await startOwner((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const node = await startNode(owner);

    const client = download(node.url);
    const { body, complete } = await client.finished;

    expect(complete).toBe(true);
    expect(body.toString()).toBe('{"ok":true}');
    expect(client.response().headers['content-length']).toBe('11');
  });
});
