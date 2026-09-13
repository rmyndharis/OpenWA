import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import { Request, Response, NextFunction, Application as ExpressApplication } from 'express';
import { BullBoardAuthMiddleware } from '../../common/security/bull-board-auth.middleware';
import { QUEUE_NAMES } from './queue-names';

/** Public URL of the Bull Board UI (global prefix `api` + board route). */
export const BULL_BOARD_BASE_PATH = '/api/admin/queues';

type ExpressLayer = { handle?: ((...args: unknown[]) => unknown) & { length: number } };

/**
 * Mount Bull Board on the raw Express app.
 *
 * Why not `@bull-board/nestjs` MiddlewareConsumer?
 * Nest 11 + Express 5 registers the board via `forRoutes('/admin/queues')`, but the
 * resulting middleware never answers `GET /api/admin/queues` (Nest 404). Auth registered
 * with `app.use` *before* `listen()`/`init()` was also skipped in production. Mounting
 * after `app.init()` and splicing the layer *before* Nest's not-found handler makes the
 * board reachable and keeps ADMIN auth in front of it.
 */
export function mountBullBoard(
  app: INestApplication,
  bullBoardAuth: BullBoardAuthMiddleware,
): void {
  if (process.env.QUEUE_ENABLED !== 'true') {
    return;
  }

  const webhookQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.WEBHOOK));
  const ingressQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.INGRESS));

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);
  createBullBoard({
    queues: [new BullMQAdapter(webhookQueue), new BullMQAdapter(ingressQueue)],
    serverAdapter,
  });

  const boardRouter = serverAdapter.getRouter();
  const expressApp = app.getHttpAdapter().getInstance() as ExpressApplication;
  const stack = (expressApp as unknown as { router: { stack: ExpressLayer[] } }).router.stack;
  const stackLengthBefore = stack.length;

  expressApp.use(
    BULL_BOARD_BASE_PATH,
    (req: Request, res: Response, next: NextFunction) => {
      void bullBoardAuth.use(req, res, next);
    },
    boardRouter,
  );

  // app.use after init() appends *after* Nest's not-found handler — splice before it.
  const added = stack.splice(stackLengthBefore);
  const isErrorHandler = (layer: ExpressLayer) => (layer.handle?.length ?? 0) >= 4;
  let insertAt = stack.length;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (!isErrorHandler(stack[i])) {
      insertAt = i;
      break;
    }
  }
  stack.splice(insertAt, 0, ...added);
}
