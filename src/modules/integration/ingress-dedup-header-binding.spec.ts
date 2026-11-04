import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IngressService, type IngressRouteDescriptor } from './ingress.service';
import { IngressEventService } from './ingress-event.service';
import { IngressEvent } from './entities/ingress-event.entity';
import type { IngressJobData } from '../queue/processors/ingress.processor';
import { getIngressDedupBodyMismatchesTotal } from '../../common/metrics/ingress-metrics';

// The provider signs timestamp and body; the delivery header is outside those signed bytes.
describe('ingress dedup on an unsigned delivery id header', () => {
  const secret = 'provider-shared-signing-secret';
  const now = 1_786_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const sign = (body: string) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  let ds: DataSource;
  let jobs: Array<{ data: IngressJobData; key: string }>;
  let service: IngressService;
  let route: IngressRouteDescriptor;
  let log: jest.Mock;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [IngressEvent],
      synchronize: true,
    }).initialize();
    const events = new IngressEventService(ds.getRepository(IngressEvent));
    jobs = [];
    log = jest.fn();
    route = {
      route: 'events',
      mode: 'async',
      verify: 'core',
      maxBodyBytes: 65536,
      signature: {
        scheme: 'hmac-sha256',
        header: 'x-signature-hex',
        timestampHeader: 'x-timestamp',
        contentTemplate: '{timestamp}.{rawBody}',
      },
    };
    service = new IngressService({
      instances: {
        resolve: () =>
          Promise.resolve({
            id: 'helpdesk:acct1',
            pluginId: 'helpdesk',
            instanceId: 'acct1',
            secret,
            enabled: true,
            sessionScope: 'sess-1',
            verifyToken: null,
          }),
      },
      manifestRoute: () => route,
      events,
      enqueue: (data, key) => {
        jobs.push({ data, key });
        return Promise.resolve();
      },
      log,
      now: () => now,
    });
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const deliver = (deliveryId: string, body: string) =>
    service.handle({
      pluginId: 'helpdesk',
      instanceId: 'acct1',
      route: 'events',
      method: 'POST',
      headers: { 'x-delivery': deliveryId, 'x-timestamp': timestamp, 'x-signature-hex': sign(body) },
      query: {},
      rawBody: body,
    });

  it('keeps header-keyed retries suppressed by default and reports a body mismatch once per request', async () => {
    const before = getIngressDedupBodyMismatchesTotal();
    await deliver('1002', '{"id":1}');
    expect((await deliver('1002', '{"id":2}')).status).toBe(202);

    expect(jobs).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('ingress_dedup_body_mismatch', {
      pluginId: 'helpdesk',
      instanceId: 'acct1',
      deliveryId: '1002',
    });
    expect(getIngressDedupBodyMismatchesTotal()).toBe(before + 1);
  });

  it.each([false, true])('deduplicates byte-identical retries with the option %p', async enabled => {
    Object.assign(route, { dedupBodyMismatchAsNew: enabled });
    await deliver('1001', '{"id":1}');
    await deliver('1001', '{"id":1}');

    expect(jobs).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('dispatches a different body once under a separate key when opted in', async () => {
    Object.assign(route, { dedupBodyMismatchAsNew: true });
    route.response = { ack: { status: 200, body: '{id}' } };
    const first = '{"event":"conversation_updated","id":1}';
    const second = '{"event":"message_created","content":"approved","id":2}';
    await deliver('1001', first);
    await deliver('1002', first);
    const accepted = await deliver('1002', second);
    await deliver('1002', second);

    expect(accepted).toMatchObject({ status: 200, body: '1002' });
    expect(jobs.map(job => job.data.payload.rawBody)).toEqual([first, first, second]);
    const copy = jobs[2];
    expect(copy.key).not.toBe('1002');
    expect(copy.data.deliveryId).toBe(copy.key);
    expect(copy.data.payload).toMatchObject({ providerDeliveryId: '1002' });
    const stored = await ds.getRepository(IngressEvent).findOneByOrFail({ providerDeliveryId: copy.key });
    expect(stored.payload).toMatchObject({ providerDeliveryId: '1002', rawBody: second });
  });

  it('enqueues concurrent copies of one mismatched body only once', async () => {
    Object.assign(route, { dedupBodyMismatchAsNew: true });
    await deliver('1001', '{"id":1}');
    await Promise.all([deliver('1001', '{"id":2}'), deliver('1001', '{"id":2}')]);

    expect(jobs).toHaveLength(2);
    expect(await ds.getRepository(IngressEvent).count()).toBe(2);
  });

  it.each([false, true])('treats a historical null fingerprint as a match with the option %p', async enabled => {
    Object.assign(route, { dedupBodyMismatchAsNew: enabled });
    await deliver('1001', '{"id":1}');
    await ds.getRepository(IngressEvent).update({ providerDeliveryId: '1001' }, { payloadHash: null });
    await deliver('1001', '{"id":2}');

    expect(jobs).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('compares the fingerprint even after dispatch retired the stored payload', async () => {
    await deliver('1001', '{"id":1}');
    await ds.getRepository(IngressEvent).update({ providerDeliveryId: '1001' }, { payload: null });
    await deliver('1001', '{"id":2}');

    expect(log).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(1);
  });
});
