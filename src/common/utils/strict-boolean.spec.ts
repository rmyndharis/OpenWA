import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsBoolean, ValidateIf } from 'class-validator';
import { ToStrictBoolean } from './strict-boolean';

// Mirrors the real pipe: whitelist + forbidNonWhitelisted from src/main.ts, and the
// enableImplicitConversion transform option from src/config/app-validation.ts. Leaving the
// transform option out here is what previously made a DTO spec pass while production accepted
// the opposite value.
const PIPE_VALIDATOR_OPTS = { whitelist: true, forbidNonWhitelisted: true };
const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };

class Subject {
  @ToStrictBoolean()
  @ValidateIf((o: Subject) => o.flag !== undefined)
  @IsBoolean()
  flag?: boolean;
}

class Unguarded {
  @ValidateIf((o: Unguarded) => o.flag !== undefined)
  @IsBoolean()
  flag?: boolean;
}

async function run<T extends object>(cls: new () => T, payload: unknown) {
  const instance = plainToInstance(cls, payload as object, PIPE_TRANSFORM_OPTS);
  const errors = await validate(instance, PIPE_VALIDATOR_OPTS);
  return { instance, errors };
}

describe('ToStrictBoolean', () => {
  it('preserves real booleans', async () => {
    for (const value of [true, false]) {
      const { instance, errors } = await run(Subject, { flag: value });
      expect(instance.flag).toBe(value);
      expect(errors).toHaveLength(0);
    }
  });

  it('maps the canonical string spellings a form-encoded body produces', async () => {
    const asFalse = await run(Subject, { flag: 'false' });
    expect(asFalse.instance.flag).toBe(false);
    expect(asFalse.errors).toHaveLength(0);

    const asTrue = await run(Subject, { flag: 'true' });
    expect(asTrue.instance.flag).toBe(true);
    expect(asTrue.errors).toHaveLength(0);
  });

  it('rejects ambiguous spellings instead of guessing', async () => {
    for (const value of ['yes', 'no', '0', '1', 'FALSE', '']) {
      const { errors } = await run(Subject, { flag: value });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('leaves an absent property absent', async () => {
    const { instance, errors } = await run(Subject, {});
    expect(instance.flag).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  // Characterizes the behaviour the decorator exists to prevent. If this ever stops failing,
  // enableImplicitConversion was turned off and the decorator can be reconsidered.
  it('documents the unguarded behaviour it replaces: every non-empty string becomes true', async () => {
    for (const value of ['false', 'no', '0']) {
      const { instance, errors } = await run(Unguarded, { flag: value });
      expect(instance.flag).toBe(true);
      expect(errors).toHaveLength(0);
    }
  });
});
