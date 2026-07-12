import { AuditAction } from './entities/audit-log.entity';
import { INTENTIONALLY_UNEMITTED_ACTIONS } from './intentionally-unemitted-actions';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural gate: every `AuditAction` enum member must either be emitted somewhere in
 * `src/` (an `AuditAction.<NAME>` literal at a real call site) or be registered in
 * `INTENTIONALLY_UNEMITTED_ACTIONS` with a reason. This keeps the audit vocabulary honest —
 * an enum value that implies an audited event cannot silently exist with no emission site,
 * and new values cannot be added without either wiring them or documenting why they are held back.
 */
const SRC_DIR = join(__dirname, '..', '..');

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules') continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      listTsFiles(full, out);
    } else if (ent.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const isExcluded = (file: string): boolean =>
  file.endsWith('.spec.ts') ||
  file.endsWith('.test.ts') ||
  file.endsWith('audit-coverage.spec.ts') ||
  file.endsWith('audit-log.entity.ts') ||
  file.endsWith('intentionally-unemitted-actions.ts');

const sourceBodies = listTsFiles(SRC_DIR)
  .filter(file => !isExcluded(file))
  .map(file => readFileSync(file, 'utf8'));

const memberKeys = Object.keys(AuditAction) as (keyof typeof AuditAction)[];

const isEmitted = (key: keyof typeof AuditAction): boolean =>
  sourceBodies.some(body => body.includes(`AuditAction.${key}`));

const memberKeyForValue = (value: string): keyof typeof AuditAction | undefined =>
  memberKeys.find(k => AuditAction[k] === (value as AuditAction));

describe('audit action emit coverage', () => {
  it.each(memberKeys)('AuditAction.%s is emitted somewhere in src/ or registered as intentionally unemitted', key => {
    const registered = Boolean(INTENTIONALLY_UNEMITTED_ACTIONS[AuditAction[key]]);
    expect(isEmitted(key) || registered).toBe(true);
  });

  it('intentionally-unemitted registry has no stale entries (none is actually emitted)', () => {
    const stale = Object.keys(INTENTIONALLY_UNEMITTED_ACTIONS)
      .map(value => memberKeyForValue(value))
      .filter((key): key is keyof typeof AuditAction => Boolean(key) && isEmitted(key));
    expect(stale).toEqual([]);
  });

  it('intentionally-unemitted registry entries each carry a non-empty reason', () => {
    const empties = Object.entries(INTENTIONALLY_UNEMITTED_ACTIONS)
      .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length === 0)
      .map(([value]) => value);
    expect(empties).toEqual([]);
  });
});
