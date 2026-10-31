import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The gate resolves its root from its own location, so each case copies the script into a throwaway
 * root next to a Dockerfile and a .dockerignore of its own and runs that copy. The repository's files
 * are only read.
 *
 * The Dockerfile COPYs its patchers by name. A .dockerignore rule that drops one still printed OK
 * while the gate asserted only a hand-picked few, and the break surfaced later as a COPY failure in
 * the multi-arch docker job.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'scripts', 'check-dockerignore.mjs');
const REAL_DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const REAL_DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

/** Run a copy of the gate in a fresh root holding `files`; `files` maps a relative path to its text. */
function runGate(files) {
  const root = mkdtempSync(join(tmpdir(), 'openwa-dockerignore-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(GATE, join(root, 'scripts', 'check-dockerignore.mjs'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const run = spawnSync(process.execPath, [join(root, 'scripts', 'check-dockerignore.mjs')], { encoding: 'utf8' });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const withRule = rule => ({ Dockerfile: REAL_DOCKERFILE, '.dockerignore': `${REAL_DOCKERIGNORE}\n${rule}\n` });

test('the repository passes its own gate', () => {
  const run = runGate({ Dockerfile: REAL_DOCKERFILE, '.dockerignore': REAL_DOCKERIGNORE });
  assert.equal(run.status, 0, run.out);
});

test('a rule that drops any patcher the Dockerfile copies fails the gate', () => {
  const patchers = readdirSync(join(ROOT, 'scripts')).filter(
    name => name.startsWith('patch-') && name.endsWith('.js') && !name.endsWith('.spec.js'),
  );
  // Non-vacuity: an empty directory scan would pass every assertion below.
  assert.ok(patchers.length >= 10, `expected the patchers to be found, saw ${patchers.length}`);
  for (const patcher of patchers) {
    const run = runGate(withRule(`scripts/${patcher}`));
    assert.equal(run.status, 1, `${patcher} is dropped by a rule and the gate passed`);
    assert.match(run.out, new RegExp(`rejects 'scripts/${patcher.replaceAll('.', '\\.')}'`), run.out);
  }
});

test('a source spelled ./x, /x, x//y or x/./y, or read by ADD, is the same build input as x', () => {
  // Docker resolves each spelling to one path in the context, which is the form the rules match.
  const sources = ['scripts/new.js', './scripts/new.js', '/scripts/new.js', 'scripts//new.js', 'scripts/./new.js'];
  for (const instruction of ['COPY', 'ADD']) {
    for (const source of sources) {
      const run = runGate({
        // The first line is a control, so that a gate which reads no ADD fails on the missing report and
        // not on having found no source at all.
        Dockerfile: `COPY control.txt ./\n${instruction} ${source} ./scripts/\n`,
        '.dockerignore': `${REAL_DOCKERIGNORE}\nscripts/new.js\n`,
      });
      assert.equal(run.status, 1, `${instruction} ${source} is dropped by a rule and the gate passed`);
      assert.match(run.out, /rejects 'scripts\/new\.js'/, `${instruction} ${source}: ${run.out}`);
    }
  }
});

test('a rule spelled ./x, x//y, x/./y or x/../x drops the file as it does in Docker', () => {
  // Docker cleans every rule with filepath.Clean, so each spelling keeps scripts/new.js out of the context.
  const rules = ['./scripts/new.js', 'scripts//new.js', 'scripts/./new.js', 'scripts/../scripts/new.js'];
  for (const rule of rules) {
    const run = runGate({
      Dockerfile: 'COPY scripts/new.js ./scripts/\n',
      '.dockerignore': `${REAL_DOCKERIGNORE}\n${rule}\n`,
    });
    assert.equal(run.status, 1, `the rule '${rule}' drops scripts/new.js and the gate passed`);
    assert.match(run.out, /rejects 'scripts\/new\.js'/, `${rule}: ${run.out}`);
  }
});

test('a negated rule is cleaned the same way', () => {
  const run = runGate({
    Dockerfile: 'COPY scripts/new.js ./scripts/\n',
    '.dockerignore': `${REAL_DOCKERIGNORE}\nscripts/new.js\n!  ./scripts/new.js\n`,
  });
  assert.equal(run.status, 0, run.out);
});

test('a rule spelled ./data/ keeps data/ out of the context as data/ does', () => {
  const dockerignore = REAL_DOCKERIGNORE.replace(/^data\/$/m, './data/');
  // Non-vacuity: the real file has a data/ line, or this would compare the file with itself.
  assert.notEqual(dockerignore, REAL_DOCKERIGNORE);
  const run = runGate({ Dockerfile: REAL_DOCKERFILE, '.dockerignore': dockerignore });
  assert.equal(run.status, 0, run.out);
});

test('an instruction continued over several lines is read whole', () => {
  // Each form builds in real BuildKit, which continues over a backslash followed by blanks or a CR, and
  // skips blank lines inside the instruction.
  const forms = {
    'a backslash': 'COPY control.txt \\\n  scripts/new.js \\\n  ./scripts/\n',
    'a backslash and a blank': 'COPY control.txt \\ \n  scripts/new.js ./scripts/\n',
    'a backslash and two blanks': 'COPY control.txt \\  \n  scripts/new.js ./scripts/\n',
    'a backslash and a tab': 'COPY control.txt \\\t\n  scripts/new.js ./scripts/\n',
    'CRLF line ends': 'COPY control.txt \\\r\n  scripts/new.js ./scripts/\r\n',
    'an empty line inside': 'COPY control.txt \\\n\n  scripts/new.js ./scripts/\n',
    'a blank line inside': 'COPY control.txt \\\n   \n  scripts/new.js ./scripts/\n',
  };
  for (const [name, dockerfile] of Object.entries(forms)) {
    const run = runGate({ Dockerfile: dockerfile, '.dockerignore': `${REAL_DOCKERIGNORE}\nscripts/new.js\n` });
    assert.equal(run.status, 1, `${name}: ${run.out}`);
    assert.match(run.out, /rejects 'scripts\/new\.js'/, `${name}: ${run.out}`);
  }
});

test('a comment ends with its line, whatever it ends in, and is not part of a continued instruction', () => {
  // BuildKit does not continue a comment, so the COPY below one that ends in a backslash is an instruction
  // of its own, and a comment between the lines of a continued instruction is dropped.
  const dockerfiles = [
    'COPY control.txt ./\n# a comment ending in a backslash \\\nCOPY scripts/new.js ./scripts/\n',
    'COPY control.txt \\\n  # a comment inside the instruction\n  scripts/new.js ./scripts/\n',
  ];
  for (const dockerfile of dockerfiles) {
    const run = runGate({ Dockerfile: dockerfile, '.dockerignore': `${REAL_DOCKERIGNORE}\nscripts/new.js\n` });
    assert.equal(run.status, 1, `${JSON.stringify(dockerfile)}: ${run.out}`);
    assert.match(run.out, /rejects 'scripts\/new\.js'/, `${JSON.stringify(dockerfile)}: ${run.out}`);
  }
});

test('the JSON array form of COPY and ADD names its sources', () => {
  // Real BuildKit builds COPY ["package.json", "./"], and it is the only form that can name a path with a blank.
  const forms = [
    ['COPY ["new.txt", "./"]', 'new.txt'],
    ['COPY ["scripts/new.js", "./scripts/"]', 'scripts/new.js'],
    ['COPY --chown=openwa:openwa ["new.txt", "./"]', 'new.txt'],
    ['ADD ["new.txt", "./"]', 'new.txt'],
    ['COPY ["dir with blank/new.txt", "./"]', 'dir with blank/new.txt'],
  ];
  for (const [line, source] of forms) {
    const run = runGate({
      Dockerfile: `COPY control.txt ./\n${line}\n`,
      '.dockerignore': `${REAL_DOCKERIGNORE}\n${source}\n`,
    });
    assert.equal(run.status, 1, `${line} is dropped by a rule and the gate passed: ${run.out}`);
    assert.match(run.out, new RegExp(`rejects '${source.replaceAll('.', '\\.')}'`), `${line}: ${run.out}`);
  }
});

test('text that looks like the JSON form but is not JSON is read as the shell form, not as a crash', () => {
  const run = runGate({ Dockerfile: 'COPY control.txt ./\nCOPY [not json]\n', '.dockerignore': REAL_DOCKERIGNORE });
  assert.equal(run.status, 0, run.out);
});

test('an indented or lower-case instruction is read like any other', () => {
  for (const line of [
    '  COPY ./scripts/new.js ./scripts/',
    'copy scripts/new.js ./scripts/',
    '\tADD scripts/new.js ./scripts/',
  ]) {
    const run = runGate({
      Dockerfile: `COPY control.txt ./\n${line}\n`,
      '.dockerignore': `${REAL_DOCKERIGNORE}\nscripts/new.js\n`,
    });
    assert.equal(run.status, 1, `'${line}' is dropped by a rule and the gate passed`);
    assert.match(run.out, /rejects 'scripts\/new\.js'/, `'${line}': ${run.out}`);
  }
});

test('a wildcard COPY source is expanded in its own directory, and only its matches are inputs', () => {
  const run = runGate({
    Dockerfile: 'COPY sub/pkg-*.txt ./\n',
    'sub/pkg-a.txt': '',
    'sub/pkg-b.txt': '',
    'sub/other.txt': '',
    '.dockerignore': `${REAL_DOCKERIGNORE}\nsub/pkg-b.txt\nsub/other.txt\n`,
  });
  assert.equal(run.status, 1, run.out);
  // A match the rules drop is reported under its path in the context, one they keep is not, and a file
  // the pattern does not match is no input even though a rule drops it.
  assert.match(run.out, /rejects 'sub\/pkg-b\.txt'/);
  assert.doesNotMatch(run.out, /rejects 'sub\/pkg-a\.txt'/);
  assert.doesNotMatch(run.out, /rejects 'sub\/other\.txt'/);
});

test('? and [..] in a COPY source are wildcards of the file name', () => {
  const files = { 'sub/pkg-a.txt': '', 'sub/pkg-b.txt': '', 'sub/pkg-ab.txt': '', 'sub/pkg-c.txt': '' };
  // A source, the rules that drop two of the files, the one the source reaches and the one it does not.
  const cases = [
    ['sub/pkg-?.txt', ['sub/pkg-b.txt', 'sub/pkg-ab.txt'], 'sub/pkg-b.txt', 'sub/pkg-ab.txt'],
    ['sub/pkg-[ab].txt', ['sub/pkg-b.txt', 'sub/pkg-c.txt'], 'sub/pkg-b.txt', 'sub/pkg-c.txt'],
  ];
  for (const [source, rules, reached, missed] of cases) {
    const run = runGate({
      ...files,
      Dockerfile: `COPY ${source} ./\n`,
      '.dockerignore': `${REAL_DOCKERIGNORE}\n${rules.join('\n')}\n`,
    });
    assert.equal(run.status, 1, `${source}: ${run.out}`);
    assert.match(run.out, new RegExp(`rejects '${reached.replaceAll('.', '\\.')}'`), `${source}: ${run.out}`);
    assert.doesNotMatch(run.out, new RegExp(`rejects '${missed.replaceAll('.', '\\.')}'`), `${source}: ${run.out}`);
  }
});

test('an http(s) URL in lower case, a git:// or ssh:// URL in any case and a user@host:path are remote ADD sources', () => {
  // Real BuildKit 0.34 fetches these, so the context is not read for them and a rule that happens to match their
  // text drops nothing the build needs.
  const remote = [
    'http://example.com/x.tgz',
    'https://example.com/x.tgz',
    'git://example.com/org/repo.git',
    'GIT://example.com/org/repo.git',
    'Git://example.com/org/repo.git',
    'ssh://git@example.com/org/repo.git',
    'SSH://git@example.com/org/repo.git',
    'git@example.com:org/repo.git',
    'deploy@example.com:org/repo.git',
    'us-er_1@host-1.example.com:org/repo.git',
  ];
  for (const source of remote) {
    const run = runGate({
      Dockerfile: `COPY control.txt ./\nADD ${source} /opt/\n`,
      // Matches the text of every source above, mangled into a context path or not.
      '.dockerignore': `${REAL_DOCKERIGNORE}\n**/*.git\n**/*.tgz\n`,
    });
    assert.equal(run.status, 0, `ADD ${source} was read as a context file: ${run.out}`);
  }
});

test('any other ADD source names a context path: ftp://, s3://, file:///, a scheme that is not in lower case, user@host', () => {
  // The same BuildKit looks in the context for these. ftp://host/x.tgz is the file ftp:/host/x.tgz, file:///x.tgz is
  // file:/x.tgz, HTTPS://host/x.tgz is HTTPS:/host/x.tgz, and user@host:path needs a user of letters, digits, _ and
  // - and a host of letters, digits, . and - to be an scp address, or it is the file of that name.
  const contextPaths = [
    ['ftp://example.com/x.tgz', 'ftp:/example.com/x.tgz'],
    ['s3://example.com/x.tgz', 's3:/example.com/x.tgz'],
    ['file:///x.tgz', 'file:/x.tgz'],
    ['HTTPS://example.com/x.tgz', 'HTTPS:/example.com/x.tgz'],
    ['HTTP://example.com/x.tgz', 'HTTP:/example.com/x.tgz'],
    ['us.er@example.com:x.tgz', 'us.er@example.com:x.tgz'],
    ['user@ho_st:x.tgz', 'user@ho_st:x.tgz'],
    ['git@example.com', 'git@example.com'],
    ['dir/user@example.com:x.tgz', 'dir/user@example.com:x.tgz'],
  ];
  for (const [source, path] of contextPaths) {
    const run = runGate({
      Dockerfile: `COPY control.txt ./\nADD ${source} /opt/\n`,
      '.dockerignore': `${REAL_DOCKERIGNORE}\n${path}\n`,
    });
    assert.equal(run.status, 1, `ADD ${source}: ${run.out}`);
    assert.match(run.out, new RegExp(`rejects '${path.replaceAll('.', '\\.')}'`), `ADD ${source}: ${run.out}`);
  }
});

test('a bracketed host after user@ is a wildcard of the context to BuildKit, not an scp address', () => {
  // Real BuildKit 0.34 builds ADD deploy@[::1]:org/repo.git without a fetch: [::1] is a class of characters, so
  // the source is a pattern over the context, and one in a directory name is what this check cannot expand.
  const run = runGate({
    Dockerfile: 'COPY control.txt ./\nADD deploy@[::1]:org/repo.git /opt/\n',
    '.dockerignore': REAL_DOCKERIGNORE,
  });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /expands a wildcard only in the file name/, run.out);
});

test('a wildcard in a directory name is reported instead of guessed', () => {
  const run = runGate({ Dockerfile: 'COPY su*/x.txt ./\n', '.dockerignore': REAL_DOCKERIGNORE });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /expands a wildcard only in the file name/);
});

test('only the context files a COPY or ADD reads are build inputs', () => {
  const keptPaths = run => {
    assert.equal(run.status, 0, run.out);
    // A reworded line would give NaN twice, and assert.equal passes two NaN.
    const count = Number(/(\d+) kept paths asserted/.exec(run.out)?.[1]);
    assert.ok(Number.isInteger(count), `no kept-paths count in: ${run.out}`);
    return count;
  };
  const gate = dockerfile => runGate({ Dockerfile: dockerfile, '.dockerignore': REAL_DOCKERIGNORE });
  const plain = keptPaths(gate('COPY src-a.txt dest-1\nCOPY src-b.txt dest-2\n'));
  // Whatever the gate counts beyond a source shows in this number, and no rule has to name it: a flag,
  // a copy from another stage, a remote ADD source, the destinations and the whole context.
  const decorated = keptPaths(
    gate(
      [
        'COPY --chown=openwa:openwa src-a.txt dest-1/',
        'COPY --from=builder /stage-src /stage-dest',
        'COPY --from=builder ["/stage-json", "/stage-json-dest"]',
        'COPY ./src-b.txt dest-2',
        'ADD http://example.com/plain.tgz /opt/',
        'ADD https://example.com/tool.tgz /opt/',
        'ADD git://example.com/org/repo.git /opt/repo',
        'ADD ssh://git@example.com/org/repo.git /opt/repo',
        'ADD git@example.com:org/repo.git /opt/repo',
        'ADD deploy@example.com:org/repo.git /opt/repo',
        'ADD GIT://example.com/org/upper.git /opt/repo',
        'ADD SSH://git@example.com/org/upper.git /opt/repo',
        'COPY . .',
        'COPY ./ ./',
        'COPY / ./',
        '',
      ].join('\n'),
    ),
  );
  assert.equal(decorated, plain);
  // The number moves with a real input, so the equality above is not one between constants.
  assert.equal(keptPaths(gate('COPY src-a.txt dest-1\nCOPY src-b.txt dest-2\nCOPY src-c.txt dest-3\n')), plain + 1);
});

test('a Dockerfile with no COPY source fails instead of passing for lack of input', () => {
  const run = runGate({ Dockerfile: 'FROM scratch\n', '.dockerignore': REAL_DOCKERIGNORE });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /COPY/);
});

// Docker anchors the bare name of a rule at the context root: `node_modules/` keeps out the top-level tree only.
// Each path is a tree a checkout grows below the root (an SDK's install or build, a coverage run, a compiler
// cache), or the media directory an install from 0.2.0 to 0.7.3 may still write.
const BELOW_ROOT = {
  '**/node_modules/': 'scripts/node_modules/zx/package.json',
  'sdk/': 'sdk/javascript/dist/cjs/index.js',
  '**/*.tsbuildinfo': 'dashboard/tsconfig.app.tsbuildinfo',
  '**/coverage/': 'dashboard/coverage/lcov.info',
  'uploads/': 'uploads/s1/2026/10/photo.jpg',
};

test('trees below the root and the legacy uploads directory stay out of the context', () => {
  const rules = Object.keys(BELOW_ROOT);
  const rootOnly = REAL_DOCKERIGNORE.split('\n')
    .filter(line => !rules.includes(line.trim()))
    .join('\n');
  const run = runGate({ Dockerfile: REAL_DOCKERFILE, '.dockerignore': rootOnly });
  assert.equal(run.status, 1, `a file with only root-level rules passed the gate: ${run.out}`);
  for (const path of Object.values(BELOW_ROOT)) {
    assert.ok(run.out.includes(`does not reject '${path}'`), `${path} is not checked: ${run.out}`);
  }
  // Non-vacuity: the real file carries each of these rules, so the run above dropped something.
  for (const rule of rules) assert.ok(REAL_DOCKERIGNORE.split('\n').includes(rule), `${rule} is not in .dockerignore`);
});

test('a rule that also takes a tracked source fails the gate', () => {
  // .gitignore ignores media/ at any depth and carves src/ out; the same rule here has no carve-out.
  const media = runGate(withRule('**/media/'));
  assert.equal(media.status, 1, media.out);
  assert.match(media.out, /rejects 'src\/modules\/media\/media\.module\.ts'/);
  assert.match(media.out, /rejects 'src\/common\/media\/media-url\.ts'/);
  // A rule over every dot file takes the .npmrc the dashboard's npm ci reads.
  const dotFiles = runGate(withRule('**/.*'));
  assert.equal(dotFiles.status, 1, dotFiles.out);
  assert.match(dotFiles.out, /rejects 'dashboard\/\.npmrc'/);
});
