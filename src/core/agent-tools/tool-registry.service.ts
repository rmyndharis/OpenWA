import { Injectable } from '@nestjs/common';
import type { AnyToolDescriptor } from './tool-descriptor';

@Injectable()
export class ToolRegistryService {
  private readonly byName = new Map<string, AnyToolDescriptor>();

  constructor(tools: AnyToolDescriptor[]) {
    for (const t of tools) {
      if (this.byName.has(t.name)) {
        throw new Error(`Duplicate agent tool name: ${t.name}`);
      }
      this.byName.set(t.name, t);
    }
  }

  list(opts: { readOnly?: boolean } = {}): AnyToolDescriptor[] {
    const all = [...this.byName.values()];
    return opts.readOnly ? all.filter(t => t.tier === 'read') : all;
  }

  get(name: string): AnyToolDescriptor | undefined {
    return this.byName.get(name);
  }
}
