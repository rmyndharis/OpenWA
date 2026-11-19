import 'reflect-metadata';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { GLOBAL_VALIDATION_OPTIONS } from '../../config/app-validation';
import { SaveConfigDto } from '../../modules/infra/dto/save-config.dto';
import { UpdateSessionConfigDto } from '../../modules/session/dto/session-config.dto';

/**
 * A body field the gateway validates with @IsInt answers a fraction with a 400, so the contract has to type it
 * `integer`: `number` lets a generated client or a schema-checking proxy send a value the route refuses. The check
 * reads the controllers (the DTO each route binds its body to, and the section DTOs that body nests), the
 * class-validator metadata and the committed openapi.json, so a new integer field published as `number` fails here.
 * A field the service refuses by hand, with no validator, is invisible to it: give that field an @IsInt.
 */
type Schema = Record<string, unknown>;
type Contract = {
  paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema: Schema }> } }>>;
  components: { schemas: Record<string, Schema> };
};

const SRC = join(__dirname, '..', '..');
const contract = JSON.parse(readFileSync(join(SRC, '..', 'openapi.json'), 'utf8')) as Contract;

const deref = (node: Schema | undefined): Schema | undefined => {
  let current = node;
  for (let depth = 0; current && '$ref' in current && depth < 8; depth++) {
    current = contract.components.schemas[String(current.$ref).split('/').pop() as string];
  }
  return current;
};

const controllerFiles = (dir: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) controllerFiles(full, found);
    else if (entry.endsWith('.controller.ts')) found.push(full);
  }
  return found;
};

/** The contract's path templates that a concrete route path (`:id` segments) can stand for. */
const templatesFor = (concrete: string): string[] =>
  Object.keys(contract.paths).filter(template =>
    new RegExp('^' + template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+') + '$').test(concrete),
  );

/** A class (a DTO is one), as far as the check needs it. */
type Dto = { name: string; prototype: object };

/** The integer fields met under the request bodies, and those among them the contract types `number`. */
type Scan = { checked: string[]; offenders: string[] };

/** The fields of a DTO, and of the DTOs it nests (the pipe validates those too), that demand an integer. */
function scanDto(dto: Dto, schema: Schema | undefined, label: string, scan: Scan): void {
  const validators = getMetadataStorage().getTargetValidationMetadatas(dto as never, undefined as never, false, false);
  for (const [field, property] of Object.entries((deref(schema)?.properties ?? {}) as Record<string, Schema>)) {
    const node = deref(property);
    if (validators.some(v => v.propertyName === field && v.name === 'isInt' && !v.each)) {
      scan.checked.push(`${label}.${field}`);
      // A list of integers admits integers only, whatever its type word says.
      const members = node?.enum as unknown[] | undefined;
      const integerList = Array.isArray(members) && members.length > 0 && members.every(Number.isInteger);
      if (!integerList && node?.type === 'number') scan.offenders.push(`${label}.${field}`);
    }
    // An object-typed section is followed, an array of DTOs is not: none holds an @IsInt field today, and @Type is
    // the way to reach one that does.
    const nested: unknown = Reflect.getMetadata('design:type', dto.prototype, field);
    if (typeof nested === 'function' && node?.properties) scanDto(nested, property, `${label}.${field}`, scan);
  }
}

/** Every body field of a route whose DTO demands an integer, and which of them the contract types `number`. */
function scanRequestBodies(): Scan {
  const scan: Scan = { checked: [], offenders: [] };
  for (const file of controllerFiles(SRC)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const controllers = require(file) as Record<string, unknown>;
    for (const controller of Object.values(controllers)) {
      if (typeof controller !== 'function') continue;
      const base = Reflect.getMetadata('path', controller) as string | string[] | undefined;
      if (base === undefined) continue;
      const proto = (controller as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
        const path = Reflect.getMetadata('path', handler) as string | string[] | undefined;
        if (method === undefined || path === undefined) continue;
        const args = (Reflect.getMetadata('__routeArguments__', controller, name) ?? {}) as Record<
          string,
          { index: number }
        >;
        const types = (Reflect.getMetadata('design:paramtypes', proto, name) ?? []) as Array<Dto | undefined>;
        for (const [key, arg] of Object.entries(args)) {
          if (Number(key.split(':')[0]) !== 3) continue; // Nest's route argument kind BODY
          const dto = types[arg.index];
          if (!dto || ['String', 'Number', 'Boolean', 'Object', 'Array'].includes(dto.name)) continue;
          const route = ('/api/' + [[base].flat()[0], [path].flat()[0]].filter(s => s && s !== '/').join('/')).replace(
            /\/+/g,
            '/',
          );
          const operation = templatesFor(route.replace(/:[A-Za-z]+/g, 'x'))
            .map(template => contract.paths[template][RequestMethod[method].toLowerCase()])
            .find(Boolean);
          scanDto(
            dto,
            operation?.requestBody?.content?.['application/json']?.schema,
            `${RequestMethod[method]} ${route} ${dto.name}`,
            scan,
          );
        }
      }
    }
  }
  return { checked: [...new Set(scan.checked)].sort(), offenders: [...new Set(scan.offenders)].sort() };
}

describe('openapi.json types an integer-only request field as an integer', () => {
  it('has no body field validated by @IsInt that the contract types as number', () => {
    expect(scanRequestBodies().offenders).toEqual([]);
  });

  // The walk has to go into a section DTO: stopping at the top level of a body would pass without reading this field.
  it('reads the integer fields of a section the body nests', () => {
    expect(scanRequestBodies().checked).toContain('PUT /api/infra/config SaveConfigDto.database.poolSize');
  });

  it('refuses a fractional reconnectBaseDelay, and the contract says integer', async () => {
    const pipe = new ValidationPipe({ ...GLOBAL_VALIDATION_OPTIONS, disableErrorMessages: false });
    await expect(
      pipe.transform({ reconnectBaseDelay: 1500.5 }, { type: 'body', metatype: UpdateSessionConfigDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const properties = deref(contract.components.schemas.UpdateSessionConfigDto)?.properties as Record<string, Schema>;
    expect(deref(properties.reconnectBaseDelay)?.type).toBe('integer');
  });

  it('refuses a fractional or negative database.poolSize, and the contract says an integer from 0', async () => {
    const pipe = new ValidationPipe({ ...GLOBAL_VALIDATION_OPTIONS, disableErrorMessages: false });
    for (const poolSize of [10.5, -1]) {
      await expect(
        pipe.transform({ database: { poolSize } }, { type: 'body', metatype: SaveConfigDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    const sent = deref(contract.components.schemas.DatabaseConfigDto)?.properties as Record<string, Schema>;
    expect(deref(sent.poolSize)).toMatchObject({ type: 'integer', minimum: 0 });
    // The value the form reads back and posts again is typed alike.
    const read = deref(contract.components.schemas.InfraConfigDatabaseDto)?.properties as Record<string, Schema>;
    expect(deref(read.poolSize)?.type).toBe('integer');
  });
});
