/**
 * setup-e2e.ts gives every suite its own state roots so a run never reads or writes the developer's
 * ./data tree. The plugin PACKAGE directory belongs to that set: the loader scans it (and, while
 * PLUGINS_DIR is unset, the legacy ./plugins too) at every AppModule boot, reconciles leftovers in it,
 * and installs into it. It must therefore resolve inside the suite's temp root, like the registry.
 */
import { resolve, sep } from 'path';
import { tmpdir } from 'os';
import configuration from '../src/config/configuration';

describe('e2e plugin package directory', () => {
  it('resolves inside the temp state root and scans no legacy tree', () => {
    const { plugins } = configuration();

    expect(resolve(plugins.dir).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(plugins.legacyDir).toBeNull();
  });
});
