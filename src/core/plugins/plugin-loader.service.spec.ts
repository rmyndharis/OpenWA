import * as path from 'path';
import { resolvePluginMainPath } from './plugin-loader.service';

/** Regression lock: a plugin's manifest.main must not escape its plugin directory. */
describe('resolvePluginMainPath', () => {
  const dir = '/app/data/plugins';

  it('allows a normal entry inside the plugin directory', () => {
    expect(resolvePluginMainPath(dir, 'my-plugin', 'index.js')).toBe(path.resolve(dir, 'my-plugin', 'index.js'));
    expect(resolvePluginMainPath(dir, 'my-plugin', 'dist/main.js')).toBe(
      path.resolve(dir, 'my-plugin', 'dist/main.js'),
    );
  });

  it('rejects a path-traversal escape (../../)', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '../../etc/passwd')).toThrow(/escapes/);
  });

  it('rejects an absolute path', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '/etc/passwd')).toThrow(/escapes/);
  });

  it('rejects climbing into a sibling plugin', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '../other-plugin/evil.js')).toThrow(/escapes/);
  });
});
