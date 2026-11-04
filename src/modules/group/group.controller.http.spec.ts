import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { applyGlobalValidation } from '../../config/app-validation';
import { configureApp } from '../../configure-app';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';

// Approve and reject act on every pending request when `participants` is absent. The body parsers read
// only JSON and form bodies, and an empty array has no property for the whitelist to refuse, so these
// run through the production parsers and pipe: a controller spec that calls the handler never sees either.
describe('GroupController membership requests over HTTP: a body that was sent but not read', () => {
  let app: INestApplication<App>;
  let port: number;
  const approve = jest.fn(() => Promise.resolve([]));
  const reject = jest.fn(() => Promise.resolve([]));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [GroupController],
      providers: [
        {
          provide: GroupService,
          useValue: { approveGroupMembershipRequests: approve, rejectGroupMembershipRequests: reject },
        },
      ],
    }).compile();
    app = mod.createNestApplication({ bodyParser: false, logger: false });
    configureApp(app);
    applyGlobalValidation(app);
    await app.listen(0);
    port = (app.getHttpServer() as { address: () => AddressInfo }).address().port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const verbs = [
    ['approve', approve],
    ['reject', reject],
  ] as const;
  const url = (verb: string) => `/api/sessions/s1/groups/120363@g.us/membership-requests/${verb}`;

  describe.each(verbs)('%s', (verb, service) => {
    it.each([
      ['an empty JSON array', 'application/json', '[]'],
      ['a text/plain body', 'text/plain', '{"participants":["628111@c.us"]}'],
      ['a +json body', 'application/vnd.api+json', '{"participants":["628111@c.us"]}'],
      ['a binary body', 'application/octet-stream', '{"participants":["628111@c.us"]}'],
    ])('refuses %s instead of acting on every pending request', async (_name, type, body) => {
      const res = await request(app.getHttpServer()).post(url(verb)).set('Content-Type', type).send(body);

      expect(res.status).toBe(400);
      expect(service).not.toHaveBeenCalled();
    });

    it('refuses a body sent without a Content-Type', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ port, method: 'POST', path: url(verb) }, res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end('{"participants":["628111@c.us"]}');
      });

      expect(status).toBe(400);
      expect(service).not.toHaveBeenCalled();
    });

    it('still acts on every pending request for an empty object and for no body at all', async () => {
      await request(app.getHttpServer()).post(url(verb)).send({}).expect(200);
      await request(app.getHttpServer()).post(url(verb)).expect(200);

      expect(service).toHaveBeenNthCalledWith(1, 's1', '120363@g.us', undefined);
      expect(service).toHaveBeenNthCalledWith(2, 's1', '120363@g.us', undefined);
    });

    it('still names the requesters of a JSON or form body', async () => {
      await request(app.getHttpServer())
        .post(url(verb))
        .send({ participants: ['628111@c.us'] })
        .expect(200);
      await request(app.getHttpServer()).post(url(verb)).type('form').send('participants[]=628222@c.us').expect(200);

      expect(service).toHaveBeenNthCalledWith(1, 's1', '120363@g.us', ['628111@c.us']);
      expect(service).toHaveBeenNthCalledWith(2, 's1', '120363@g.us', ['628222@c.us']);
    });
  });
});
