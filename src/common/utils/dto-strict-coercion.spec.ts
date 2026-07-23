import 'reflect-metadata';
import { getMetadataStorage, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Drift gate for the input-coercion contract.
 *
 * The global ValidationPipe runs with `transformOptions.enableImplicitConversion: true`
 * (`src/config/app-validation.ts`). That is deliberate — it lets a client send `"5"` for a numeric
 * field, which form-encoded bodies and several HTTP clients do by default. But it also means
 * class-transformer rewrites the value BEFORE any `@Is*` validator sees it, and two of its
 * conversions destroy information rather than preserving it:
 *
 *   Boolean  — every non-empty string becomes `true`, so `"false"`, `"no"` and `"0"` all arrive as
 *              `true` and `@IsBoolean()` can never reject them.
 *   Number   — `Number('')` and `Number('   ')` are `0`, so a blank field arrives as a real zero
 *              and `@IsInt()`/`@IsNumber()` accept it.
 *
 * Both fail toward the more permissive value, which is how a `forEveryone=false` delete became a
 * delete-for-everyone. `ToStrictBoolean`/`ToStrictNumber` (`./strict-boolean`) restore the
 * rejection while keeping the useful half of the conversion.
 *
 * This spec asserts the BEHAVIOUR rather than the presence of a decorator, so any future mechanism
 * that produces the same guarantee also satisfies it. Every boolean and numeric property that
 * carries validation metadata is covered — including classes that are never exported, because
 * discovery walks class-validator's own registry rather than module exports.
 */

const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };
const PIPE_VALIDATOR_OPTS = { whitelist: true, forbidNonWhitelisted: true };

/** The value each type is probed with, and why it must be refused. */
const PROBES: Record<string, { value: string; reason: string }> = {
  Boolean: { value: 'yes', reason: 'implicit conversion turns any non-empty string into true' },
  Number: { value: '', reason: 'Number("") is 0, so a blank field becomes a real zero' },
};

function dtoFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) dtoFiles(path, out);
    else if (path.endsWith('.dto.ts') && !path.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

// Importing every DTO module registers its decorators. Classes only reach the registry once their
// module has been loaded, so this has to happen before the registry is read.
const SRC = join(__dirname, '..', '..');
dtoFiles(SRC).forEach(file => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(file);
});

interface ValidatedClass {
  new (...args: never[]): object;
  name: string;
  prototype: object;
}

function registeredClasses(): ValidatedClass[] {
  const storage = getMetadataStorage() as unknown as { validationMetadatas?: Map<unknown, unknown> };
  const registry = storage.validationMetadatas;
  if (!(registry instanceof Map)) {
    // The internal shape changed. Fail loudly — a silently empty scan would report "no drift".
    throw new Error('class-validator metadata registry is not the expected Map; update this spec');
  }
  return [...registry.keys()].filter((k): k is ValidatedClass => typeof k === 'function');
}

function coercibleProps(cls: ValidatedClass): Array<{ prop: string; type: string }> {
  const metas = getMetadataStorage().getTargetValidationMetadatas(cls, cls.name, true, false);
  const props = [...new Set(metas.map(m => m.propertyName))];
  return props
    .map(prop => {
      const declared = Reflect.getMetadata('design:type', cls.prototype, prop) as { name?: string } | undefined;
      return { prop, type: declared?.name ?? '' };
    })
    .filter(({ type }) => type in PROBES);
}

describe('DTO input-coercion drift gate', () => {
  const classes = registeredClasses();
  const targets = classes.flatMap(cls => coercibleProps(cls).map(p => ({ cls, ...p })));

  // Guard the DISCOVERY, not just the assertions. A scan that silently finds nothing would report a
  // clean result forever; these pin the mechanism against a known-positive of each kind.
  it('discovers the DTO registry, including classes that are never exported', () => {
    const names = classes.map(c => c.name);
    expect(names).toContain('DeleteMessageDto'); // exported, top-level
    expect(names).toContain('BulkMessageOptionsDto'); // NOT exported — reached only via the registry
    expect(names.length).toBeGreaterThanOrEqual(40);
  });

  it('finds both a boolean and a numeric property to check', () => {
    expect(targets.some(t => t.type === 'Boolean')).toBe(true);
    expect(targets.some(t => t.type === 'Number')).toBe(true);
    expect(targets.length).toBeGreaterThanOrEqual(15);
  });

  it.each(targets.map(t => [`${t.cls.name}.${t.prop}`, t] as const))(
    '%s refuses a value the pipe would otherwise coerce',
    async (_label, target) => {
      const { value, reason } = PROBES[target.type];
      const instance = plainToInstance(target.cls, { [target.prop]: value }, PIPE_TRANSFORM_OPTS);
      const errors = await validate(instance, PIPE_VALIDATOR_OPTS);

      // Only this property's verdict matters — other properties may be absent and report their own
      // errors, which is irrelevant here.
      const refused = errors.some(e => e.property === target.prop);
      expect(
        refused ||
          `${target.cls.name}.${target.prop} accepted ${JSON.stringify(value)} — ${reason}. ` +
            `Add @ToStrict${target.type}() from common/utils/strict-boolean.`,
      ).toBe(true);
    },
  );
});
