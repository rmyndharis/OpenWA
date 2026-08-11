import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { withInboundDownloadTimeout } from './inbound-media-cap';

/**
 * The whatsapp-web.js half of the inbound-media burst bound.
 *
 * `baileys-inbound-burst.spec.ts` pins the same property on the other engine, where a queue cap
 * equal to the active slots made admission a constant 8 whatever the batch size, so a burst lost
 * the media of everything past the eighth. The whatsapp-web.js adapter carried the identical
 * construction and kept losing media the same way after the Baileys side was repaired.
 *
 * Unbounding the queue is safe here for a reason that does not hold on Baileys: only the DOWNLOAD
 * runs inside the limiter, not the whole message pipeline, and each message awaits its own
 * `capInboundMediaFor`, so a parked download delays that message alone.
 *
 * But removing the cap removes a degradation as well as a defect, and the second test below is the
 * one that matters. A slot is held until its download REALLY settles — deliberately, so an
 * abandoned download cannot let a fresh one exceed the concurrency bound — and a hung page never
 * settles. The rejected-on-full-queue path used to unblock everyone behind it; with no cap and no
 * bound on the wait, a burst behind stuck slots would park forever and those messages would never
 * be emitted at all, which is strictly worse than emitting them without media.
 */
describe('whatsapp-web.js inbound media burst', () => {
  it('gives the inbound limiter an unbounded queue, so a burst parks instead of shedding', () => {
    const source = readFileSync(join(__dirname, 'whatsapp-web-js.adapter.ts'), 'utf8');
    const construction = source.match(/new ConcurrencyLimiter\(([\s\S]*?)\);/);

    // Guard the parser: a renamed limiter would make this vacuous.
    expect(construction).not.toBeNull();

    const args = (construction?.[1] ?? '')
      .split(',')
      .map(arg => arg.replace(/\/\/[^\n]*/g, '').trim())
      .filter(Boolean);
    expect(args).toEqual(['inboundMediaConcurrency()']);
  });

  it('bounds the caller wait, so a message behind permanently stuck slots still resolves', async () => {
    // The real composition: a limiter whose slots never free, and a caller awaiting admission.
    const limiter = new ConcurrencyLimiter(1);
    const wedged = new Promise<never>(() => undefined); // a download that never settles
    void limiter.run(() => wedged); // takes the only slot and keeps it

    let admitted = false;
    const boundedReady = limiter.run(() => {
      admitted = true;
      return Promise.resolve({ data: 'QUJD', mimetype: 'image/jpeg' });
    });

    const media = await withInboundDownloadTimeout(boundedReady, 25);

    expect(admitted).toBe(false); // it never got a slot...
    expect(media).toBeNull(); // ...and the caller still unblocked, to emit without media
  });

  it('wraps the caller wait in the timeout rather than only the admitted download', () => {
    // Structural, because the behaviour above is composition-level: the inner race starts once the
    // task is ADMITTED, so it cannot cover the queue wait. Awaiting boundedReady bare is the shape
    // that reintroduces the unbounded wait.
    const source = readFileSync(join(__dirname, 'whatsapp-web-js.adapter.ts'), 'utf8');

    expect(source).toMatch(/await\s+withInboundDownloadTimeout\(\s*boundedReady\s*,/);
    expect(source).not.toMatch(/const\s+media\s*=\s*await\s+boundedReady\s*;/);
  });
});
