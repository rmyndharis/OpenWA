import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { needs?: string[]; outputs?: Record<string, string>; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };

/**
 * The release-tags job decides which image channels a release may move, and whether the GitHub Release
 * becomes the Latest one. It runs against two registries, so here its script runs under stand-ins for
 * `docker` and `curl`: the version labels each channel carries, and what the registry answers when
 * asked for a tag that is not there, are the inputs; the selected tags and the exit status the outputs.
 */
describe('release.yml release-tags', () => {
  const workflow = load(
    readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8'),
  ) as Workflow;
  const select = workflow.jobs['release-tags'].steps!.find(step => step.id === 'select')!;

  const GHCR = 'ghcr.io/example/openwa';
  const HUB = 'docker.io/example/openwa';
  const stableTags = (version: string, minor: string): string[] =>
    [GHCR, HUB].flatMap(image => [`${image}:${version}`, `${image}:${minor}`, `${image}:latest`]);

  const platform = (version: string | null) => ({
    config: { Labels: version === null ? {} : { 'org.opencontainers.image.version': version } },
  });
  /** What `docker buildx imagetools inspect --format '{{json .Image}}'` prints for a two-platform image. */
  const image = (amd64: string | null, arm64: string | null = amd64, arm64Key = 'linux/arm64'): string =>
    JSON.stringify({ 'linux/amd64': platform(amd64), [arm64Key]: platform(arm64) });

  const MANIFEST_UNKNOWN = '{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}';
  const BUILT = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const OTHER = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

  type Registry = { down?: boolean; status?: number; body?: string };
  type Scenario = {
    refName: string;
    version: string;
    tags: string[];
    /** Channel tag -> output of the image inspection; a tag left out is not found by `docker`. */
    images?: Record<string, string>;
    /** Exact version tag -> the digest it already serves; a tag left out is not found by `docker`. */
    digests?: Record<string, string>;
    /** The digest this run built. */
    built?: string;
    registry?: Registry;
  };

  const run = (scenario: Scenario): { status: number; output: string; tags: string[]; latest: string } => {
    const directory = mkdtempSync(join(tmpdir(), 'openwa-release-tags-'));
    try {
      const bin = join(directory, 'bin');
      const fake = join(directory, 'fake');
      mkdirSync(bin);
      mkdirSync(join(fake, 'image'), { recursive: true });
      mkdirSync(join(fake, 'digest'));
      writeFileSync(
        join(bin, 'docker'),
        [
          '#!/bin/bash',
          '[ "$1 $2 $3" = "buildx imagetools inspect" ] || { echo "unexpected docker $*" >&2; exit 2; }',
          'dir=image; [ "$6" != "{{.Manifest.Digest}}" ] || dir=digest',
          'file="$FAKE_DIR/$dir/$(printf %s "$4" | tr "/:" "__")"',
          '[ -f "$file" ] && exec cat "$file"',
          'echo "ERROR: $4: not found" >&2',
          'exit 1',
        ].join('\n'),
      );
      writeFileSync(
        join(bin, 'curl'),
        [
          '#!/bin/bash',
          'out=""; url=""',
          'while [ $# -gt 0 ]; do',
          '  case "$1" in',
          '    --output) out=$2; shift 2 ;;',
          '    --write-out | --header | --connect-timeout | --max-time) shift 2 ;;',
          '    -*) shift ;;',
          '    *) url=$1; shift ;;',
          '  esac',
          'done',
          '[ ! -f "$FAKE_DIR/registry-down" ] || exit 7',
          'case "$url" in',
          '  */token*) printf \'{"token":"t"}\' ;;',
          '  *) cp "$FAKE_DIR/manifest-body" "$out"; cat "$FAKE_DIR/manifest-status" ;;',
          'esac',
        ].join('\n'),
      );
      chmodSync(join(bin, 'docker'), 0o755);
      chmodSync(join(bin, 'curl'), 0o755);
      for (const [tag, json] of Object.entries(scenario.images ?? {})) {
        writeFileSync(join(fake, 'image', tag.replace(/[/:]/g, '_')), json);
      }
      for (const [tag, digest] of Object.entries(scenario.digests ?? {})) {
        writeFileSync(join(fake, 'digest', tag.replace(/[/:]/g, '_')), `${digest}\n`);
      }
      const registry = scenario.registry ?? {};
      if (registry.down) writeFileSync(join(fake, 'registry-down'), '');
      writeFileSync(join(fake, 'manifest-status'), String(registry.status ?? 404));
      writeFileSync(join(fake, 'manifest-body'), registry.body ?? MANIFEST_UNKNOWN);

      const outputFile = join(directory, 'github-output');
      writeFileSync(outputFile, '');
      const result = spawnSync('/bin/bash', ['-e', '-c', select.run!], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 20000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_DIR: fake,
          REF_NAME: scenario.refName,
          VERSION: scenario.version,
          TAGS: scenario.tags.join('\n'),
          EXPECTED_DIGEST: scenario.built ?? BUILT,
          GITHUB_OUTPUT: outputFile,
        },
      });
      const output = readFileSync(outputFile, 'utf8');
      const block = /^tags<<RELEASE_TAGS\n([\s\S]*?)\nRELEASE_TAGS$/m.exec(output);
      return {
        status: result.status ?? -1,
        output: `${result.stdout}${result.stderr}`,
        tags: block ? block[1].split('\n') : [],
        latest: /^latest=(.*)$/m.exec(output)?.[1] ?? '',
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  it('finds the script and the tools it needs', () => {
    expect(select.run).toContain('channel_version');
    expect(spawnSync('jq', ['--version']).status).toBe(0);
  });

  // The runs below hand the script EXPECTED_DIGEST themselves, so where the workflow takes it from is pinned here.
  it('compares the exact tags with the digest the docker job built', () => {
    expect(select.env?.EXPECTED_DIGEST).toBe('${{ needs.docker.outputs.digest }}');
    expect(workflow.jobs['release-tags'].needs).toContain('docker');
  });

  it('moves every channel for a release that leads, and marks it Latest', () => {
    const tags = stableTags('0.27.0', '0.27');
    const result = run({
      refName: 'v0.27.0',
      version: '0.27.0',
      tags,
      // The new minor line has no channel yet: the registry answers 404 MANIFEST_UNKNOWN for it.
      images: { [`${GHCR}:latest`]: image('0.26.0'), [`${HUB}:latest`]: image('0.26.0', '0.26.0', 'linux/arm64/v8') },
    });
    expect(result).toMatchObject({ status: 0, tags, latest: 'true' });
  });

  it('keeps latest where it is for a patch to an older line, and does not mark it Latest', () => {
    const result = run({
      refName: 'v0.25.1',
      version: '0.25.1',
      tags: stableTags('0.25.1', '0.25'),
      images: {
        [`${GHCR}:latest`]: image('0.26.0'),
        [`${HUB}:latest`]: image('0.26.0'),
        [`${GHCR}:0.25`]: image('0.25.0'),
        [`${HUB}:0.25`]: image('0.25.0'),
      },
    });
    expect(result.status).toBe(0);
    expect(result.tags).toEqual([`${GHCR}:0.25.1`, `${GHCR}:0.25`, `${HUB}:0.25.1`, `${HUB}:0.25`]);
    expect(result.latest).toBe('false');
    expect(result.output).toContain(`Keeping ${GHCR}:latest at newer release 0.26.0`);
  });

  it('does not mark the release Latest when only one registry has moved on', () => {
    const result = run({
      refName: 'v0.26.1',
      version: '0.26.1',
      tags: stableTags('0.26.1', '0.26'),
      images: {
        [`${GHCR}:latest`]: image('0.26.0'),
        [`${HUB}:latest`]: image('0.27.0'),
        [`${GHCR}:0.26`]: image('0.26.0'),
        [`${HUB}:0.26`]: image('0.26.0'),
      },
    });
    expect(result.status).toBe(0);
    expect(result.tags).toEqual([`${GHCR}:0.26.1`, `${GHCR}:0.26`, `${GHCR}:latest`, `${HUB}:0.26.1`, `${HUB}:0.26`]);
    expect(result.latest).toBe('false');
  });

  it('selects every channel again for a re-run of the release a channel already serves', () => {
    const tags = stableTags('0.26.0', '0.26');
    const same = image('0.26.0');
    const result = run({
      refName: 'v0.26.0',
      version: '0.26.0',
      tags,
      images: Object.fromEntries(tags.filter(tag => !tag.endsWith(':0.26.0')).map(tag => [tag, same])),
    });
    expect(result).toMatchObject({ status: 0, tags, latest: 'true' });
  });

  it('publishes a prerelease under its exact tags only and never as Latest', () => {
    const tags = [`${GHCR}:0.27.0-rc.1`, `${HUB}:0.27.0-rc.1`];
    const result = run({ refName: 'v0.27.0-rc.1', version: '0.27.0-rc.1', tags });
    expect(result).toMatchObject({ status: 0, tags, latest: 'false' });
  });

  it('treats the first release on an empty repository as leading', () => {
    const tags = stableTags('0.1.0', '0.1');
    expect(run({ refName: 'v0.1.0', version: '0.1.0', tags })).toMatchObject({ status: 0, tags, latest: 'true' });
  });

  // An image build is not reproducible, so a second full run of a published tag builds other content. The exact
  // version tag keeps what it was published with; only this run's own digest may be applied to it again.
  describe('never re-points a published exact version tag at other content', () => {
    const tags = stableTags('0.27.0', '0.27');
    const published = { [`${GHCR}:latest`]: image('0.27.0'), [`${HUB}:latest`]: image('0.27.0') };

    it('selects it again when it already serves the digest this run built (failed jobs re-run)', () => {
      const result = run({
        refName: 'v0.27.0',
        version: '0.27.0',
        tags,
        images: published,
        digests: { [`${GHCR}:0.27.0`]: BUILT, [`${HUB}:0.27.0`]: BUILT },
      });
      expect(result).toMatchObject({ status: 0, tags, latest: 'true' });
    });

    it.each([
      ['GHCR', `${GHCR}:0.27.0`],
      ['Docker Hub', `${HUB}:0.27.0`],
    ])('fails before promotion when %s serves it at another digest', (_registry, tag) => {
      const result = run({ refName: 'v0.27.0', version: '0.27.0', tags, images: published, digests: { [tag]: OTHER } });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`::error::${tag} is already published as ${OTHER}, not this run's ${BUILT}`);
      expect(result.tags).toEqual([]);
    });

    it('fails for a prerelease the same way', () => {
      const pre = [`${GHCR}:0.27.0-rc.1`, `${HUB}:0.27.0-rc.1`];
      const result = run({ refName: 'v0.27.0-rc.1', version: '0.27.0-rc.1', tags: pre, digests: { [pre[0]]: OTHER } });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`::error::${pre[0]} is already published as ${OTHER}`);
      expect(result.tags).toEqual([]);
    });
  });

  describe('fails the release rather than guess, naming what it could not read', () => {
    // The exact tags already serve this build, so every lookup below that fails is a channel's.
    const base = {
      refName: 'v0.27.0',
      version: '0.27.0',
      tags: stableTags('0.27.0', '0.27'),
      digests: { [`${GHCR}:0.27.0`]: BUILT, [`${HUB}:0.27.0`]: BUILT },
    };

    it.each([
      ['an unreachable registry', { down: true }, 'Cannot get a registry token for'],
      ['HTTP 429', { status: 429, body: '{"errors":[{"code":"TOOMANYREQUESTS"}]}' }, '(registry HTTP 429)'],
      ['HTTP 500', { status: 500, body: 'internal error' }, '(registry HTTP 500)'],
      ['an HTML 404', { status: 404, body: '<html>404 page not found</html>' }, '(registry HTTP 404)'],
      [
        'a 404 that is not "manifest unknown"',
        { status: 404, body: '{"errors":[{"code":"DENIED"}]}' },
        '(registry HTTP 404)',
      ],
    ] as [string, Registry, string][])('%s for a channel that is not found', (_name, registry, message) => {
      const result = run({ ...base, registry });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('::error::');
      expect(result.output).toContain(message);
      expect(result.output).toContain(`${GHCR}:0.27`);
      expect(result.output).not.toContain(`${GHCR}:0.27.0`);
      expect(result.tags).toEqual([]);
    });

    it.each([
      ['an image without a version label', image(null), 'no consistent version label'],
      ['labels that differ between the platforms', image('0.26.0', '0.25.0'), 'no consistent version label'],
      ['an empty version label', image('', ''), 'no stable release version identity'],
      ['a prerelease version label', image('0.26.0-rc.1'), 'no stable release version identity'],
    ])('%s on the latest channel', (_name, json, message) => {
      const result = run({ ...base, images: { [`${GHCR}:latest`]: json } });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(message);
      expect(result.output).toContain(`::error::${GHCR}:latest`);
      expect(result.tags).toEqual([]);
    });

    // A prerelease moves no channel, so the exact tags are the only lookups it makes.
    it.each([
      ['an unreachable registry', { down: true }, 'Cannot get a registry token for'],
      ['HTTP 500', { status: 500, body: 'internal error' }, '(registry HTTP 500)'],
    ] as [string, Registry, string][])('%s for an exact version tag that is not found', (_name, registry, message) => {
      const pre = [`${GHCR}:0.27.0-rc.1`, `${HUB}:0.27.0-rc.1`];
      const result = run({ refName: 'v0.27.0-rc.1', version: '0.27.0-rc.1', tags: pre, registry });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('::error::');
      expect(result.output).toContain(message);
      expect(result.output).toContain(pre[0]);
      expect(result.tags).toEqual([]);
    });

    it('an empty version from the build', () => {
      const result = run({ ...base, version: '', tags: [`${GHCR}:0.27`, `${GHCR}:latest`] });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Cannot order release version ''");
    });

    it('a release tag that does not belong to the version', () => {
      const result = run({ ...base, tags: [`${GHCR}:0.26.9`] });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`Unexpected release tag ${GHCR}:0.26.9`);
    });
  });

  it('hands the GitHub Release the decision, which is false for a prerelease and an older line', () => {
    const release = workflow.jobs.release;
    const publish = release.steps!.find(step => step.name === 'Create GitHub Release')!;
    expect(release.needs).toContain('release-tags');
    expect(workflow.jobs['release-tags'].outputs?.latest).toBe('${{ steps.select.outputs.latest }}');
    expect(publish.with?.make_latest).toBe('${{ needs.release-tags.outputs.latest }}');
  });
});
