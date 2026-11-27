import {
  ArgumentMetadata,
  BadRequestException,
  INestApplication,
  PipeTransform,
  ValidationPipe,
  ValidationPipeOptions,
} from '@nestjs/common';
import { isValidationErrorDetailEnabled } from './bootstrap-security';
import { containsNul } from '../common/validation/no-nul-character';
import { BODY_WIDTH_MESSAGES, MAX_BODY_OBJECT_KEYS, exceededBodyWidth } from '../common/validation/body-width';
import { ImportDataDto } from '../modules/infra/dto/import-data.dto';

/**
 * The DTO validation contract itself, without the one option that depends on the environment.
 *
 * Exported so a spec can construct the real pipe from the same object production uses instead of
 * restating the options as literals. A restated copy is a mirror, and a mirror can drift: loosening
 * `whitelist` here would leave every spec that hardcoded `whitelist: true` still asserting the old
 * contract, green, while the running app no longer honours it. Reading one object makes production
 * and the specs unable to disagree — and turns those specs into a gate over this file.
 *
 * `disableErrorMessages` is deliberately NOT here: it is resolved from the environment at call time,
 * so it is not part of the contract a spec should reproduce.
 */
export const GLOBAL_VALIDATION_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
};

/**
 * Refuses a request body holding U+0000 anywhere. PostgreSQL rejects it in every text and varchar value
 * and bound parameter, so it failed the lookup or write behind the route as a 500 while SQLite took it.
 * The restore is exempt: a SQLite backup may hold one in a message, and the importers drop it from the
 * same free-text columns the entities clean.
 */
export class NulBodyPipe implements PipeTransform {
  transform(value: unknown, { type, metatype }: ArgumentMetadata): unknown {
    if (type === 'body' && metatype !== ImportDataDto && containsNul(value)) {
      throw new BadRequestException('Request body must not contain a NUL character');
    }
    return value;
  }
}

/** What ValidationPipe passes over because no class defines the value, so the width bound does too. */
const NOT_A_DTO: unknown[] = [String, Boolean, Number, Array, Object, Buffer, Date];

/**
 * Refuses a request body too wide for the validation pipe to copy (see body-width.ts) with a 400 that names the limit
 * it exceeded. It runs BEFORE that pipe, which copies the whole body before any validator can refuse it, and only
 * for a body a DTO defines: the restore lifts the array-length and total-entry caps because its tables hold as many
 * rows as the database does, while still capping keys per object so no single object stalls class-transformer. A
 * provider-defined body (integration ingress, plugin-hosted routes) is read raw and never reaches a pipe.
 */
export class BodyWidthPipe implements PipeTransform {
  transform(value: unknown, { type, metatype }: ArgumentMetadata): unknown {
    if (type !== 'body' || !metatype || NOT_A_DTO.includes(metatype)) return value;
    const exceeded =
      metatype === ImportDataDto
        ? exceededBodyWidth(value, {
            maxArrayLength: Infinity,
            maxEntries: Infinity,
            maxObjectKeys: MAX_BODY_OBJECT_KEYS,
          })
        : exceededBodyWidth(value);
    if (exceeded) throw new BadRequestException(BODY_WIDTH_MESSAGES[exceeded]);
    return value;
  }
}

/** Whether an object with its own `toString` sits anywhere in a parsed request value. */
const holdsOwnToString = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  ((!Array.isArray(value) && Object.hasOwn(value, 'toString')) || Object.values(value).some(holdsOwnToString));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The ValidationPipe, answering as the caller's mistake the one failure its implicit conversion raises on the caller's
 * data. A string or number property is converted with String() or Number(), and both throw a TypeError on an object
 * whose own `toString` is not a function, before any validator runs, which would answer 500 for a value every other
 * wrong type answers 400 for. Only that case is answered: a TypeError from the application's own code (a custom
 * transform, a validator) is a defect and still reaches the exception handler, so the body must hold such an object.
 *
 * A restore body is validated without its `tables`, which ImportDataDto never descends into, and handed on with the
 * parsed tables themselves: transforming them copied every row of the database, which held the event loop for about
 * 4 s at 45,000 messages.
 */
export class GlobalValidationPipe extends ValidationPipe {
  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    const tables = metadata.metatype === ImportDataDto && isPlainObject(value) ? value.tables : undefined;
    const input = isPlainObject(tables) ? { ...(value as object), tables: {} } : value;
    try {
      const result: unknown = await super.transform(input, metadata);
      if (input !== value) (result as { tables: unknown }).tables = tables;
      return result;
    } catch (error) {
      if (error instanceof TypeError && holdsOwnToString(input)) {
        // The pipe also runs over a query DTO, so the answer names the part of the request that holds the value.
        throw new BadRequestException(
          `Request ${metadata.type === 'custom' ? 'input' : metadata.type} holds a value of the wrong type`,
        );
      }
      throw error;
    }
  }
}

/** Apply the HTTP prefix and DTO validation contract shared by production and e2e applications. */
export function applyGlobalValidation(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new BodyWidthPipe(),
    new GlobalValidationPipe({
      ...GLOBAL_VALIDATION_OPTIONS,
      disableErrorMessages: !isValidationErrorDetailEnabled(process.env.VALIDATION_ERROR_DETAIL, process.env.NODE_ENV),
    }),
    new NulBodyPipe(),
  );
}
