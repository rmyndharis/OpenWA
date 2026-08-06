import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Baileys draws the amplitude bars on a voice note from `audio-decode`, which it declares as an
 * OPTIONAL peer dependency and dynamically imports at send time. It was never installed, so the
 * import threw on every send, was swallowed by a debug-level catch, and each voice note went out
 * with no waveform at all — a silent failure with no signal anywhere above `debug`.
 *
 * This asserts the dependency is present and usable rather than re-testing Baileys' algorithm,
 * which is not ours to pin. It cannot drive the real `getAudioWaveform` here: Baileys is ESM-only,
 * every other Baileys spec in this repo mocks the package for exactly that reason, and a mocked
 * module would prove nothing about whether the optional dependency actually resolves.
 *
 * The version check is the other half. Baileys asks for a specific major, and installing a newer
 * one satisfies `require.resolve` while leaving the peer range unmet — the decoder is then present
 * but Baileys' own contract is broken, which is precisely the shape a routine dependency bump takes.
 */
describe('Baileys voice-note waveform dependency', () => {
  const readJson = (...segments: string[]): Record<string, unknown> =>
    JSON.parse(readFileSync(join(__dirname, '..', '..', '..', ...segments), 'utf8')) as Record<string, unknown>;

  it('is installed, so the waveform import does not throw at send time', () => {
    expect(() => require.resolve('audio-decode')).not.toThrow();
  });

  it('is a declared dependency, not an accident of someone else’s tree', () => {
    const pkg = readJson('package.json');
    const deps = pkg.dependencies as Record<string, string>;

    // Left to a transitive install it would vanish the moment that other package dropped it, and
    // the failure would again be a debug-level line nobody reads.
    expect(deps['audio-decode']).toBeDefined();
  });

  it('is the major version Baileys itself asks for', () => {
    const baileys = readJson('node_modules', '@whiskeysockets', 'baileys', 'package.json');
    const wanted = (baileys.peerDependencies as Record<string, string>)['audio-decode'];
    const installed = readJson('node_modules', 'audio-decode', 'package.json').version as string;

    // Guard the guard: if Baileys ever stops declaring it, this must fail loudly rather than
    // silently comparing against undefined and passing.
    expect(wanted).toBeDefined();

    // Compared by major rather than by resolving the full range: a major mismatch is the failure
    // that actually happens — the newest release installs cleanly, resolves fine, and quietly does
    // not meet the peer range Baileys published. Doing it here keeps a semver parser out of the
    // dependency list for one comparison.
    const majorOf = (spec: string): string => /(\d+)\./.exec(spec)?.[1] ?? '';
    expect(majorOf(installed)).toBe(majorOf(wanted));
    expect(majorOf(installed)).not.toBe('');
  });
});
