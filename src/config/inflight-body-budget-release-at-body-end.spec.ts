import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo } from 'net';
import express, { json } from 'express';
import { createInflightBodyBudget, InflightBodyBudget } from './inflight-body-budget';

// A reservation covers the transfer of a body, not the work a handler does with it afterwards. The JSON and form
// parsers sit right behind the budget, and the request stream closes as soon as the last byte is in, so the bytes
// a running handler holds are not counted. docs/04-security-design.md and .env.example describe it that way.

const KB = 1024;

describe('in-flight body budget over real HTTP, once a body has been read', () => {
  let server: Server | undefined;
  let budget: InflightBodyBudget;
  let port = 0;
  let releaseHandler: () => void = () => undefined;
  let handlerEntered: Promise<void>;

  beforeEach(async () => {
    budget = createInflightBodyBudget(1024 * KB, { perClientShare: 1 });
    let entered: () => void = () => undefined;
    handlerEntered = new Promise<void>(resolve => (entered = resolve));
    const gate = new Promise<void>(resolve => (releaseHandler = resolve));
    const app = express();
    app.use(budget.middleware);
    app.use(json({ limit: '25mb' }));
    app.post('/slow', async (_req, res) => {
      entered();
      await gate;
      res.status(200).json({ ok: true });
    });
    app.post('/fast', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    releaseHandler();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  /** A JSON body of exactly `bytes` bytes, resolved with the status the server answered. */
  const send = (path: string, bytes: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ data: 'a'.repeat(bytes - 11) }));
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  it('stops counting a body once it has been read, while its handler is still running', async () => {
    const first = send('/slow', 700 * KB);
    await handlerEntered;
    // Let the request stream finish its own lifecycle events before the reading below.
    await new Promise(resolve => setTimeout(resolve, 50));

    const heldWhileHandling = budget.currentBytes();
    const second = await send('/fast', 700 * KB);
    releaseHandler();
    expect(await first).toBe(200);

    expect({ heldWhileHandling, second }).toEqual({ heldWhileHandling: 0, second: 200 });
  });
});
