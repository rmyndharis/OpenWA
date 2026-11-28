// Structural guard for capability blocklist coverage. A key carrying deniedPermissions is
// fail-closed on an untagged route in ApiKeyGuard; this test makes every non-public handler state
// which capability it reaches, or explicitly declare itself a capability-agnostic self-check.
import { readdirSync, readFileSync } from 'fs';
import { join, sep } from 'path';

export function handlersMissingCapability(source: string): string[] {
  const beforeClass = source.split('export class')[0] ?? '';
  const classIsPublic = /@Public\(\)/.test(beforeClass);
  const classIsTagged = /@Capability\(/.test(beforeClass);
  const classIsAgnostic = /@CapabilityAgnostic\(\)/.test(beforeClass);
  if (classIsPublic || classIsTagged || classIsAgnostic) return [];

  const offenders: string[] = [];
  const handlerRe = /((?:^ +@[\s\S]*?)?)^ +(?:async\s+)?([a-zA-Z0-9_]+)\s*\(/gm;
  for (let match = handlerRe.exec(source); match !== null; match = handlerRe.exec(source)) {
    const [, decorators, name] = match;
    if (name === 'constructor') continue;
    if (!/@(Get|Post|Put|Patch|Delete|All|Sse|Head)\(/.test(decorators)) continue;
    if (/@Public\(\)/.test(decorators)) continue;
    if (/@Capability\(/.test(decorators)) continue;
    if (/@CapabilityAgnostic\(\)/.test(decorators)) continue;
    offenders.push(name);
  }
  return offenders;
}

function controllerFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...controllerFiles(full));
    else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) files.push(full);
  }
  return files;
}

describe('authenticated REST routes declare capability coverage', () => {
  it('detects an untagged authenticated handler', () => {
    const source = `
export class ExampleController {
  @Get('items')
  list(): string[] { return []; }
}`;
    expect(handlersMissingCapability(source)).toEqual(['list']);
  });

  it('accepts a tagged handler and an explicitly agnostic self-check', () => {
    const source = `
export class ExampleController {
  @Capability(ApiKeyCapability.CHATS_READ)
  @Get('items')
  list(): string[] { return []; }

  @CapabilityAgnostic()
  @Post('validate')
  validate(): boolean { return true; }
}`;
    expect(handlersMissingCapability(source)).toEqual([]);
  });

  it('finds no real non-public handler without an explicit capability decision', () => {
    const offenders: string[] = [];
    for (const file of controllerFiles(join(__dirname, '..'))) {
      for (const handler of handlersMissingCapability(readFileSync(file, 'utf8'))) {
        offenders.push(
          `${file
            .split(sep)
            .join('/')
            .replace(/.*\/src\//, 'src/')} :: ${handler}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
