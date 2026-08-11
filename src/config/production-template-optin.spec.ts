import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { isSwaggerEnabled, isValidationErrorDetailEnabled } from './bootstrap-security';

/**
 * `.env.example` is both the "copy me" template and a self-described production config — it ships
 * `NODE_ENV=production` uncommented. Anything else shipped uncommented becomes a PIN the moment an
 * operator copies the file, so a setting that defaults OFF under production must not be pre-selected
 * ON in the template: copying it would silently opt a production host into the very thing the
 * default exists to withhold.
 *
 * This is deliberately BEHAVIOURAL rather than lexical. A lexical "KEY must not appear uncommented"
 * rule mis-fires on settings shipped uncommented in the SAFE direction, and it cannot tell the two
 * apart. Here the template is parsed and the REAL resolvers are run over it, so a key only counts
 * when the template's own value resolves ON while the unset default would resolve OFF.
 */

/** Resolvers that default OFF under production and are forced ON by an explicit `true`. */
const PRODUCTION_OFF_OPT_INS: ReadonlyArray<{
  key: string;
  resolve: (value: string | undefined, nodeEnv: string | undefined) => boolean;
}> = [
  { key: 'ENABLE_SWAGGER', resolve: isSwaggerEnabled },
  { key: 'VALIDATION_ERROR_DETAIL', resolve: isValidationErrorDetailEnabled },
];

/**
 * The production-off opt-ins a copied template would pre-select. Empty for a template that does not
 * declare production — the rule is about what `cp .env.example .env` pins on a production host.
 */
function preSelectedOptIns(templateText: string): string[] {
  const env = dotenv.parse(templateText);
  if (env.NODE_ENV !== 'production') return [];
  return PRODUCTION_OFF_OPT_INS.filter(
    optIn => optIn.resolve(env[optIn.key], env.NODE_ENV) && !optIn.resolve(undefined, env.NODE_ENV),
  ).map(optIn => optIn.key);
}

describe('.env.example does not pre-select a production-off opt-in', () => {
  const templatePath = path.join(__dirname, '..', '..', '.env.example');
  const template = fs.readFileSync(templatePath, 'utf8');

  it('pre-selects nothing that production defaults off', () => {
    expect(preSelectedOptIns(template)).toEqual([]);
  });

  it('still gives a developer the documented defaults when they set NODE_ENV=development', () => {
    // The reason a bare removal is not the fix: shipping `ENABLE_SWAGGER=false` would also satisfy
    // the assertion above while breaking the contributor workflow that copies this same file.
    const env = dotenv.parse(template);
    expect(isSwaggerEnabled(env.ENABLE_SWAGGER, 'development')).toBe(true);
    expect(isValidationErrorDetailEnabled(env.VALIDATION_ERROR_DETAIL, 'development')).toBe(true);
  });

  it('leaves the documented production opt-in working when an operator sets it themselves', () => {
    expect(isSwaggerEnabled('true', 'production')).toBe(true);
    expect(isValidationErrorDetailEnabled('true', 'production')).toBe(true);
  });

  // Self-mutation controls: the check must be capable of firing, and must not fire on the safe cases.
  it('fires when a production-off opt-in is shipped uncommented', () => {
    expect(preSelectedOptIns(`${template}\nVALIDATION_ERROR_DETAIL=true\n`)).toEqual(['VALIDATION_ERROR_DETAIL']);
    expect(preSelectedOptIns(`${template}\nENABLE_SWAGGER=true\n`)).toEqual(['ENABLE_SWAGGER']);
  });

  it('does not fire on a template that declares a non-production environment', () => {
    const asDevelopment = `${template}\nNODE_ENV=development\nENABLE_SWAGGER=true\n`;
    expect(preSelectedOptIns(asDevelopment)).toEqual([]);
  });

  it('does not fire on a setting shipped uncommented in the safe direction', () => {
    expect(preSelectedOptIns(`${template}\nVALIDATION_ERROR_DETAIL=false\n`)).toEqual([]);
  });
});
