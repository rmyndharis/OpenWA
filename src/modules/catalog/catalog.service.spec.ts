import { BadRequestException, HttpException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import type { SendPacingService } from '../message/send-pacing.service';
import { HookManager } from '../../core/hooks';
import type {
  IWhatsAppEngine,
  Catalog,
  Product,
  PaginatedProducts,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';

const catalog: Catalog = { id: 'cat-1', name: 'Toko Kue', productCount: 2, url: 'https://wa.me/c/628123' };
const product: Product = {
  id: 'prod-1',
  name: 'Brownies',
  price: 25000,
  currency: 'IDR',
  priceFormatted: 'Rp25.000',
  url: 'https://wa.me/p/prod-1/628123',
  isAvailable: true,
};
const page: PaginatedProducts = { products: [product], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
const sent: MessageResult = { id: 'wamid.product', timestamp: 1_706_868_000 };

/** No plugin registered: HookManager hands the envelope back unchanged. */
const passThroughHooks = () => ({
  execute: jest.fn((_event: string, data: unknown) => Promise.resolve({ continue: true, data })),
});

describe('CatalogService', () => {
  const makeService = (
    engine: Partial<IWhatsAppEngine> | undefined,
    pacing?: { assertSendAllowed: jest.Mock },
    hookManager = passThroughHooks(),
  ) => {
    const engines = new EngineRegistry();
    if (engine) engines.set('s1', engine as IWhatsAppEngine);
    const sendPacing = {
      assertSendAllowed: jest.fn().mockResolvedValue(undefined),
      recordSendSuccess: jest.fn(),
      recordSendFailure: jest.fn(),
      ...pacing,
    };
    return {
      svc: new CatalogService(
        engines,
        sendPacing as unknown as SendPacingService,
        hookManager as unknown as HookManager,
      ),
      pacing: sendPacing,
      hookManager,
    };
  };

  describe('catalog reads', () => {
    it.each(['getCatalog', 'getProducts', 'getProduct'] as const)(
      'rejects with 404 for %s when the session is not started',
      async method => {
        const { svc } = makeService(undefined);
        const promise =
          method === 'getProduct'
            ? svc.getProduct('s1', 'prod-1')
            : method === 'getProducts'
              ? svc.getProducts('s1')
              : svc.getCatalog('s1');
        await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      },
    );

    it('delegates getCatalog to the engine and returns its answer (null when the account has none)', async () => {
      const getCatalog = jest.fn().mockResolvedValue(catalog);
      const { svc } = makeService({ getCatalog });
      await expect(svc.getCatalog('s1')).resolves.toBe(catalog);

      getCatalog.mockResolvedValue(null);
      await expect(svc.getCatalog('s1')).resolves.toBeNull();
    });

    it('delegates getProducts with the requested page window', async () => {
      const getProducts = jest.fn().mockResolvedValue(page);
      const { svc } = makeService({ getProducts });
      await expect(svc.getProducts('s1', 3, 50)).resolves.toBe(page);
      expect(getProducts).toHaveBeenCalledWith({ page: 3, limit: 50 });
    });

    it('defaults getProducts to the first page of 20', async () => {
      const getProducts = jest.fn().mockResolvedValue(page);
      await makeService({ getProducts }).svc.getProducts('s1');
      expect(getProducts).toHaveBeenCalledWith({ page: 1, limit: 20 });
    });

    it('delegates getProduct and passes an unknown id through as null (not a 404)', async () => {
      const getProduct = jest.fn().mockResolvedValue(null);
      await expect(makeService({ getProduct }).svc.getProduct('s1', 'prod-404')).resolves.toBeNull();
      expect(getProduct).toHaveBeenCalledWith('prod-404');
    });

    it('propagates an engine failure instead of reporting an empty catalog', async () => {
      const down = new NotImplementedException('catalog query unanswered');
      const getCatalog = jest.fn().mockRejectedValue(down);
      await expect(makeService({ getCatalog }).svc.getCatalog('s1')).rejects.toBe(down);
    });
  });

  describe('product-message sends', () => {
    it('rejects with 404 for sendProduct when the session is not started', async () => {
      const { svc } = makeService(undefined);
      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('paces a product send BEFORE it reaches the engine', async () => {
      const order: string[] = [];
      const pacing = {
        assertSendAllowed: jest.fn().mockImplementation(() => {
          order.push('pace');
          return Promise.resolve();
        }),
      };
      const sendProduct = jest.fn().mockImplementation(() => {
        order.push('send');
        return Promise.resolve(sent);
      });
      const { svc } = makeService({ sendProduct }, pacing);

      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1', 'Back in stock!')).resolves.toBe(sent);
      expect(order).toEqual(['pace', 'send']);
      expect(pacing.assertSendAllowed).toHaveBeenCalledWith('s1', '628123@c.us');
      expect(sendProduct).toHaveBeenCalledWith('628123@c.us', 'prod-1', 'Back in stock!');
    });

    // A product card is a chat send like any other, so a moderation plugin that polices every chat
    // send must be able to stop it too.
    it('offers the product send to message:sending and sends nothing when a plugin vetoes it', async () => {
      const hookManager = { execute: jest.fn().mockResolvedValue({ continue: false }) };
      const sendProduct = jest.fn().mockResolvedValue(sent);
      const { svc, pacing } = makeService({ sendProduct }, undefined, hookManager);

      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1', 'Back in stock!')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sending',
        {
          sessionId: 's1',
          type: 'product',
          input: { chatId: '628123@c.us', productId: 'prod-1', body: 'Back in stock!' },
        },
        { sessionId: 's1', source: 'CatalogService' },
      );
      expect(sendProduct).not.toHaveBeenCalled();
      expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    });

    it('sends the gated productId and body, but always to the requested chat', async () => {
      const hookManager = {
        execute: jest.fn().mockResolvedValue({
          continue: true,
          data: { input: { chatId: 'other@c.us', productId: 'prod-2', body: 'Rewritten' } },
        }),
      };
      const sendProduct = jest.fn().mockResolvedValue(sent);
      const { svc } = makeService({ sendProduct }, undefined, hookManager);

      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1', 'Back in stock!')).resolves.toBe(sent);
      expect(sendProduct).toHaveBeenCalledWith('628123@c.us', 'prod-2', 'Rewritten');
    });

    it.each([
      ['a non-string productId', { productId: 42 }],
      ['an empty productId', { productId: '' }],
      ['a non-string body', { productId: 'prod-1', body: { text: 'x' } }],
    ])('refuses with 400 when a plugin returns %s', async (_label, input) => {
      const hookManager = { execute: jest.fn().mockResolvedValue({ continue: true, data: { input } }) };
      const sendProduct = jest.fn().mockResolvedValue(sent);
      const { svc } = makeService({ sendProduct }, undefined, hookManager);

      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(sendProduct).not.toHaveBeenCalled();
    });

    it('refuses on pacing before the plugin gate is consulted', async () => {
      const pacing = { assertSendAllowed: jest.fn().mockRejectedValue(new HttpException('paced', 429)) };
      const sendProduct = jest.fn();
      const { svc, hookManager } = makeService({ sendProduct }, pacing);

      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1')).rejects.toMatchObject({ status: 429 });
      expect(hookManager.execute).not.toHaveBeenCalled();
      expect(sendProduct).not.toHaveBeenCalled();
    });

    it('propagates an engine failure from sendProduct', async () => {
      const down = new Error('socket closed');
      const sendProduct = jest.fn().mockRejectedValue(down);
      await expect(makeService({ sendProduct }).svc.sendProduct('s1', '628123@c.us', 'prod-1')).rejects.toBe(down);
    });

    it('reports the engine outcome of a product send to the pacing breaker', async () => {
      const sendProduct = jest.fn().mockResolvedValue(sent);
      const { svc, pacing } = makeService({ sendProduct });
      await svc.sendProduct('s1', '628123@c.us', 'prod-1');
      expect(pacing.recordSendSuccess).toHaveBeenCalledWith('s1');

      const refused = new EngineRefusedError('refused');
      sendProduct.mockRejectedValue(refused);
      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1')).rejects.toBe(refused);
      expect(pacing.recordSendFailure).toHaveBeenCalledWith('s1');
    });

    it('does not feed a client-fault or unsupported refusal to the breaker', async () => {
      const sendProduct = jest
        .fn()
        .mockRejectedValueOnce(new NotFoundException('Product not found'))
        .mockRejectedValueOnce(new EngineNotSupportedError('sendProduct'));
      const { svc, pacing } = makeService({ sendProduct });
      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-404')).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1')).rejects.toBeInstanceOf(EngineNotSupportedError);
      expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    });

    // A JSON null body passes the DTO (IsOptional) and, with no plugin installed, the gate hands the
    // caller's own envelope back. It must send like an absent body, not fail as a plugin's bad output.
    it('sends a null body as no body when no plugin is installed', async () => {
      const sendProduct = jest.fn().mockResolvedValue(sent);
      const { svc } = makeService({ sendProduct }, undefined, new HookManager() as never);

      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1', null as unknown as string)).resolves.toBe(sent);

      expect(sendProduct).toHaveBeenCalledWith('628123@c.us', 'prod-1', undefined);
    });
  });
});
