import * as fs from 'fs';
import * as path from 'path';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * A list route's `limit` and `offset` are integer counts: the handlers read them with parseInt and
 * resolveListWindow clamps the result. A parameter published as a string types a generated client's
 * argument as text. No range is asserted on purpose: the server clamps out-of-range values rather
 * than refusing them, so a published minimum or maximum would make a validating client refuse what
 * the server accepts.
 */

const OPERATION_KEYS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

type QueryParameter = { in?: string; name?: string; schema?: { type?: string } };

const snapshot = (): OpenAPIObject =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.json'), 'utf8')) as OpenAPIObject;

describe('openapi.json list-window query parameters', () => {
  it('publishes every limit and offset query parameter as an integer', () => {
    const notInteger: string[] = [];
    let seen = 0;

    for (const [route, item] of Object.entries(snapshot().paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!OPERATION_KEYS.has(method)) continue;
        for (const p of (operation as { parameters?: QueryParameter[] }).parameters ?? []) {
          if (p.in !== 'query' || (p.name !== 'limit' && p.name !== 'offset')) continue;
          seen++;
          if (p.schema?.type !== 'integer') {
            notInteger.push(`${method.toUpperCase()} ${route} ${p.name}: ${p.schema?.type}`);
          }
        }
      }
    }

    // Vacuity guard: a parse that found no parameter would pass the comparison below.
    expect(seen).toBeGreaterThanOrEqual(20);
    expect(notInteger).toEqual([]);
  });
});
