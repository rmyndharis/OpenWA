import 'reflect-metadata';
import { getMetadataStorage, validate, ValidationTypes } from 'class-validator';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Drift gate for the input-coercion contract.
 *
 * The global ValidationPipe runs with `transformOptions.enableImplicitConversion: true`
 * (`src/config/app-validation.ts`). That is deliberate — it lets a client send `"5"` for a numeric
 * field, which form-encoded bodies and several HTTP clients do by default. But it also means
 * class-transformer rewrites the value BEFORE any `@Is*` validator sees it, and four of its
 * conversions destroy information rather than preserving it:
 *
 *   Boolean  — every non-empty string becomes `true`, so `"false"`, `"no"` and `"0"` all arrive as
 *              `true` and `@IsBoolean()` can never reject them.
 *   Number   — `Number('')` and `Number('   ')` are `0`, so a blank field arrives as a real zero
 *              and `@IsInt()`/`@IsNumber()` accept it.
 *   String   - a boolean or object becomes its string form (`true`, `[object Object]`), so `@IsString()`
 *              accepts it and the route sends text the caller never wrote. A number keeps the conversion,
 *              because clients that hold a phone number as a number rely on it.
 *   Array    - an object becomes an EMPTY array (class-transformer builds `new Array()` and copies the keys
 *              onto it), so `@IsArray()` accepts it. Where an empty list means "no restriction", as in the
 *              key lists `allowedChats`, `allowedSessions` and `allowedIps`, a map sent by mistake created
 *              a key with no restriction at all.
 *
 * The first, second and fourth fail toward the more permissive value, which is how a `forEveryone=false`
 * delete became a delete-for-everyone. `ToStrictBoolean`/`ToStrictNumber`/`ToStrictString`/`ToStrictArray`
 * (`./strict-boolean`) restore the rejection while keeping the useful half of the conversion.
 *
 * This spec asserts the BEHAVIOUR rather than the presence of a decorator, so any future mechanism
 * that produces the same guarantee also satisfies it. Every boolean and numeric property that
 * carries validation metadata is covered — including classes that are never exported, because
 * discovery walks class-validator's own registry rather than module exports. So is every string one, and
 * every list. Only `*.dto.ts` files are loaded, so a request class declared in a controller escapes.
 */

const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };
const PIPE_VALIDATOR_OPTS = { whitelist: true, forbidNonWhitelisted: true };

/** The values each type is probed with, and why each must be refused. */
const PROBES: Record<string, { values: unknown[]; reason: string }> = {
  Boolean: { values: ['yes'], reason: 'implicit conversion turns any non-empty string into true' },
  Number: { values: [''], reason: 'Number("") is 0, so a blank field becomes a real zero' },
  // Two string forms, because they differ: "true" passes a name rule that "[object Object]" fails, so one
  // probe alone would let such a field skip the decorator. An array is never converted, so it pins that it
  // stays refused. A number is not here: it is converted on purpose, and asserted separately below.
  String: {
    values: [true, { order: 42 }, ['a']],
    reason: 'implicit conversion rewrites a boolean or an object into its string form, which @IsString accepts',
  },
  // A map is the mistake that matters: {"628111@c.us":true} sent for a list of chats.
  Array: {
    values: [{}, { '628111@c.us': true }],
    reason: 'class-transformer turns an object into an empty array, which @IsArray accepts',
  },
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

// class-transformer's own constructor type, not a hand-rolled copy: `plainToInstance` is what these
// are handed to, so its contract is the one that has to hold.
type ValidatedClass = ClassConstructor<object> & { name: string; prototype: object };

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

  it('finds a boolean, a numeric, a string and a list property to check', () => {
    expect(targets.some(t => t.type === 'Boolean')).toBe(true);
    expect(targets.some(t => t.type === 'Number')).toBe(true);
    expect(targets.some(t => t.type === 'String')).toBe(true);
    expect(targets.some(t => t.type === 'Array')).toBe(true);
    expect(targets.length).toBeGreaterThanOrEqual(15);
    // Most request fields are text, so a scan that came up with none of them would report a clean result.
    expect(targets.filter(t => t.type === 'String').length).toBeGreaterThanOrEqual(100);
  });

  it.each(targets.flatMap(t => PROBES[t.type].values.map(value => [`${t.cls.name}.${t.prop}`, value, t] as const)))(
    '%s refuses %j, which the pipe would otherwise coerce',
    async (_label, value, target) => {
      const { reason } = PROBES[target.type];
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

  // Clients that hold a phone number or a chat id as a number post it as one, and every release has read it
  // as its decimal string. The value reaching the validators is checked, not the verdict: a pattern such as
  // a chat id's legitimately refuses the digits, which is not the conversion going missing.
  it.each(targets.filter(t => t.type === 'String').map(t => [`${t.cls.name}.${t.prop}`, t] as const))(
    '%s still reads a number as its decimal string',
    (_label, target) => {
      const instance = plainToInstance(target.cls, { [target.prop]: 628123456789 }, PIPE_TRANSFORM_OPTS);
      expect((instance as Record<string, unknown>)[target.prop]).toBe('628123456789');
    },
  );

  // The verdict above can pass vacuously where a list also needs a minimum size: the empty list an object
  // turns into is refused by ArrayNotEmpty, and that guard is one edit from gone. So the value reaching the
  // validators is checked as well: an object stays an object, and a real list stays a list.
  const listTargets = targets.filter(t => t.type === 'Array');

  it.each(listTargets.map(t => [`${t.cls.name}.${t.prop}`, t] as const))(
    '%s does not turn an object into a list, and still reads a list as a list',
    (_label, target) => {
      const read = (value: unknown) =>
        (plainToInstance(target.cls, { [target.prop]: value }, PIPE_TRANSFORM_OPTS) as Record<string, unknown>)[
          target.prop
        ];
      expect(Array.isArray(read({ '628111@c.us': true }))).toBe(false);
      expect(read([])).toEqual([]);
      expect(Array.isArray(read([]))).toBe(true);
    },
  );
});

/**
 * The same class of drift for a single nested object. It is declared with `@ValidateNested() @Type()`,
 * and `@ValidateNested` checks an array element by element, so without `@IsObject()` an array (even an
 * empty one) passed and the handler read the object's fields off it: bulk `options` sent as `[{...}]`
 * was stored as the defaults with the caller's values dropped.
 */
function nestedObjectProps(cls: ValidatedClass): string[] {
  const metas = getMetadataStorage().getTargetValidationMetadatas(cls, cls.name, true, false);
  const nested = metas.filter(m => m.type === ValidationTypes.NESTED_VALIDATION && !m.each);
  return [...new Set(nested.map(m => m.propertyName))];
}

describe('DTO nested-object drift gate', () => {
  const targets = registeredClasses().flatMap(cls => nestedObjectProps(cls).map(prop => ({ cls, prop })));

  it('finds the nested object properties to check', () => {
    expect(targets.length).toBeGreaterThanOrEqual(15);
  });

  it.each(targets.map(t => [`${t.cls.name}.${t.prop}`, t] as const))('%s refuses an array', async (_label, target) => {
    const instance = plainToInstance(target.cls, { [target.prop]: [] }, PIPE_TRANSFORM_OPTS);
    const errors = await validate(instance, PIPE_VALIDATOR_OPTS);

    const refused = errors.some(e => e.property === target.prop);
    expect(refused || `${target.cls.name}.${target.prop} accepted an array. Add @IsObject().`).toBe(true);
  });
});
