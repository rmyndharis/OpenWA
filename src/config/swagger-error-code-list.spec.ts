import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SchemaObject } from '@nestjs/swagger';
import { documentErrorResponses, ERROR_RESPONSE_SCHEMA } from './swagger.config';

/**
 * ErrorResponse.code is written by hand and presents itself as the list of the stable reasons an error body can
 * carry. A code is found where the source puts it into a body: `code: 'NAME'`, or `code: NAME` beside a
 * `const NAME = 'VALUE'`. A comment line is prose and is not read.
 */
const CODE_AT = /\bcode: '?([A-Z][A-Z0-9_]+)'?/g;
const CONSTANT = /\bconst ([A-Z][A-Z0-9_]+) = '([A-Z][A-Z0-9_]+)'/g;

function codesIn(sources: string[]): string[] {
  const constants = new Map(sources.flatMap(text => [...text.matchAll(CONSTANT)].map(m => [m[1], m[2]] as const)));
  const codes = new Set<string>();
  for (const text of sources) {
    for (const line of text.split('\n')) {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      for (const m of line.matchAll(CODE_AT)) codes.add(m[0].includes("'") ? m[1] : (constants.get(m[1]) ?? m[1]));
    }
  }
  return [...codes].sort();
}

// The per-item result of a bulk send, which sits inside a 200 body and is never an error response.
const NOT_AN_ERROR_BODY = new Set(['SEND_BLOCKED', 'SEND_FAILED']);

describe('ErrorResponse.code list', () => {
  const schema = documentErrorResponses({
    openapi: '3.0.0',
    info: { title: 't', version: '0' },
    paths: {},
    components: {},
  }).components?.schemas?.[ERROR_RESPONSE_SCHEMA] as SchemaObject;
  const named = new Set((schema.properties?.code as SchemaObject).description?.match(/[A-Z][A-Z0-9_]{3,}/g));
  const srcRoot = join(__dirname, '..');
  const sources = (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map(file => readFileSync(join(srcRoot, file), 'utf8'));

  it('names every stable code the source puts into an error body', () => {
    const emitted = codesIn(sources).filter(code => !NOT_AN_ERROR_BODY.has(code));

    // Both spellings must be found, or the comparison below proves nothing.
    expect(emitted).toEqual(
      expect.arrayContaining([
        'IMPORT_ALREADY_RUNNING',
        'RESTART_ALREADY_RUNNING',
        'RESTART_DATABASE_NOT_STARTED',
        'SEND_PACING_LIMITED',
        'ENGINE_PAGE_RELOADING',
      ]),
    );
    expect(emitted.filter(code => !named.has(code))).toEqual([]);
  });

  describe('codesIn', () => {
    it('reads a literal and a constant, and skips a comment line', () => {
      expect(
        codesIn([
          "export const SAME = 'SAME';\nexport const RENAMED = 'WIRE_VALUE';\n",
          "throw new E({ code: 'LITERAL' });\nthrow new E({ code: SAME });\nthrow new E({ code: RENAMED });\n" +
            "// code: 'IN_LINE_COMMENT'\n * `code: 'IN_BLOCK_COMMENT'`\n",
        ]),
      ).toEqual(['LITERAL', 'SAME', 'WIRE_VALUE']);
    });
  });
});
