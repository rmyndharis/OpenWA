#!/usr/bin/env node
/**
 * Spec for check-contract-shapes.mjs — a gate that cannot fail is worse than no gate, so these
 * cases pin the comparator's failure modes against inline fixtures: field presence both ways,
 * optionality flips, token-level drift (widened union, enum mismatch), and the hand parser's
 * regular cases. The `without a ?` case pins a real regression: the member regex once made its
 * literal-`?` group mandatory, so every required field silently failed to parse and the gate
 * compared against a half-empty hand type.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  comparePair,
  exposedSchemas,
  handToken,
  parseGoTypes,
  parseHandTypes,
  parseJavaTypes,
  parseObjectToken,
  parsePythonTypes,
  schemaCoverageProblems,
  schemaToken,
  unexposedResources,
} from './check-contract-shapes.mjs';

const handSource = `
export interface Sample {
  id: string; // inline comment on field
  name?: string;
  direction: string;
  count: number | null;
}
`;

test('parseHandTypes reads required and optional members (a required field is not silently dropped)', () => {
  const types = parseHandTypes(handSource);
  assert.deepEqual(Object.keys(types.Sample), ['id', 'name', 'direction', 'count']);
  assert.equal(types.Sample.id.optional, false);
  assert.equal(types.Sample.name.optional, true);
});

test('parsers handle Windows CRLF line endings identically to LF', () => {
  const crlfHand = handSource.replace(/\n/g, '\r\n');
  assert.deepEqual(parseHandTypes(crlfHand), parseHandTypes(handSource));

  const pySource = 'class Sample(TypedDict):\n    id: str\n    name: NotRequired[str]\n';
  const crlfPy = pySource.replace(/\n/g, '\r\n');
  assert.deepEqual(parsePythonTypes(crlfPy), parsePythonTypes(pySource));
});

const schemas = {
  SampleDto: {
    type: 'object',
    required: ['id', 'direction', 'count'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      direction: { type: 'string', enum: ['incoming', 'outgoing'] },
      count: { type: 'integer' },
    },
  },
  SameDto: {
    type: 'object',
    required: ['id', 'direction', 'count'],
    properties: {
      id: { type: 'string' },
      direction: { type: 'string', enum: ['incoming', 'outgoing'] },
      count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    },
  },
};

test('comparePair returns no diffs for a conforming pair', () => {
  const hand = {
    id: { optional: false, token: 'string' },
    direction: { optional: false, token: "'incoming' | 'outgoing'" },
    count: { optional: false, token: 'number | null' },
  };
  assert.deepEqual(comparePair('Same', hand, 'SameDto', schemas.SameDto, schemas), []);
});

test('comparePair flags a field the contract has and the hand lacks, and vice versa', () => {
  const hand = { id: { optional: false, token: 'string' }, extra: { optional: false, token: 'string' } };
  const diffs = comparePair('Sample', hand, 'SampleDto', schemas.SampleDto, schemas);
  assert.ok(diffs.some(d => d.includes('hand has "extra"')));
  assert.ok(
    diffs.some(
      d =>
        d.includes('contract has "name"') ||
        d.includes('contract has "direction"') ||
        d.includes('contract has "count"'),
    ),
  );
});

test('comparePair flags an optionality flip', () => {
  const hand = { id: { optional: true, token: 'string' } };
  const diffs = comparePair('Sample', hand, 'SampleDto', schemas.SampleDto, schemas);
  assert.ok(diffs.some(d => d.includes('"id": hand optional, contract required')));
});

test('comparePair flags a widened union and an enum mismatch at token level', () => {
  const hand = {
    id: { optional: false, token: 'string' },
    direction: { optional: false, token: 'string' },
    count: { optional: false, token: 'number | null' },
  };
  const diffs = comparePair('Sample', hand, 'SampleDto', schemas.SampleDto, schemas);
  assert.ok(diffs.some(d => d.includes('"direction": hand string, contract enum(["incoming","outgoing"])')));
  assert.ok(diffs.some(d => d.includes('"count": hand number|null, contract number')));
});

test('comparePair flags a primitive widened to a union of primitives', () => {
  // A two-member union reduces to union(...), which is not a simple token; dropping the diff on that
  // ground let `string | number` (or Python's `str | int`) stand in for a plain `string` unseen.
  const hand = {
    id: { optional: false, token: 'string | number' },
    direction: { optional: false, token: "'incoming' | 'outgoing'" },
    count: { optional: false, token: 'str | int' },
  };
  const diffs = comparePair('Sample', hand, 'SampleDto', schemas.SampleDto, schemas);
  assert.ok(diffs.some(d => d.includes('"id": hand union(number,string), contract string')));
  assert.ok(diffs.some(d => d.includes('"count": hand union(int,str), contract number')));
});

test('comparePair with namesOnly keeps the field names and drops optionality and token', () => {
  // The excluded Go and Java pairs keep a deliberately looser type: that stays accepted, a renamed field does not.
  const loose = {
    id: { optional: true, token: 'number' },
    direction: { optional: false, token: 'string' },
    count: { optional: false, token: 'string' },
    name: { optional: false, token: 'string' },
  };
  assert.deepEqual(comparePair('Sample', loose, 'SampleDto', schemas.SampleDto, schemas, true, true), []);
  assert.ok(comparePair('Sample', loose, 'SampleDto', schemas.SampleDto, schemas, true).length > 0);
  const renamed = { ...loose, nmae: loose.name };
  delete renamed.name;
  const diffs = comparePair('Sample', renamed, 'SampleDto', schemas.SampleDto, schemas, true, true);
  assert.equal(diffs.length, 2);
  assert.ok(diffs[0].startsWith('hand has "nmae"') && diffs[1].startsWith('contract has "name"'));
});

test('parseObjectToken splits nested object tokens without losing members', () => {
  const members = parseObjectToken('object(id:string,sub:object(a:number,b?:boolean),tail:string)');
  assert.deepEqual(Object.keys(members), ['id', 'sub', 'tail']);
  assert.equal(members.b?.optional ?? parseObjectToken(members.sub.token).b.optional, true);
});

test('handToken reduces enums, null unions and arrays deterministically', () => {
  const types = {};
  assert.equal(handToken("'b' | 'a'", types), 'enum(["a","b"])'.replace(',', ','));
  assert.equal(handToken('number | null', types), 'number|null');
  assert.equal(handToken('string[]', types), 'array<string>');
});

test('schemaToken honors the OpenAPI 3.0 sibling nullable flag', () => {
  // Regression: nullable is a sibling flag, not a type member — dropping it turned every honest
  // `string | null` hand type into a false mismatch against a plain `string` schema.
  const nullableSchema = { type: 'string', nullable: true };
  assert.equal(schemaToken(nullableSchema, {}), 'string|null');
  assert.equal(schemaToken({ type: 'string' }, {}), 'string');
  assert.equal(schemaToken({ type: 'integer', nullable: true }, {}), 'number|null');
});

test('parseHandTypes resolves `extends` — inherited fields are not "missing"', () => {
  // Regression: CreatedApiKey extends ApiKey read as a bare { apiKey } shape and could never
  // conform to the schema that actually includes every inherited member.
  const types = parseHandTypes(`
export interface Base {
  id: string;
}
export interface Child extends Base {
  apiKey: string;
}
`);
  assert.deepEqual(Object.keys(types.Child), ['id', 'apiKey']);
});

test('parsePythonTypes: TypedDict totals, NotRequired, aliased Literal enums, inheritance', () => {
  const src = [
    'SessionStatus = Literal[',
    '    "created",',
    '    "ready",',
    ']',
    '',
    'class Base(TypedDict, total=False):',
    '    id: str',
    '',
    'class Session(Base):',
    '    name: str',
    '    status: SessionStatus',
    '    lastError: NotRequired[str | None]',
  ].join('\n');
  const types = parsePythonTypes(src);
  assert.equal(types.Session.id.optional, true, 'inherited total=False member stays optional');
  assert.equal(types.Session.name.optional, false);
  assert.equal(types.Session.status.token, 'enum(["created","ready"])');
  assert.equal(types.Session.lastError.optional, true);
  assert.equal(types.Session.lastError.token, 'string|null');
});

test('parsePythonTypes: a trailing comment neither hides NotRequired nor leaves an unreadable type', () => {
  const src = [
    'class Media(TypedDict):',
    '    id: str  # the media id',
    '    data: NotRequired[str]  # base64; absent when omitted (too large)',
  ].join('\n');
  const media = parsePythonTypes(src).Media;
  assert.equal(media.data.optional, true);
  assert.equal(media.data.token, 'string');
  assert.equal(media.id.optional, false);
  assert.equal(media.id.token, 'string');
});

test('parseGoTypes: omitempty optionality, pointer nullability, const-block enums, required slices', () => {
  const src = [
    'type Kind string',
    '',
    'const (',
    '\tKindOne Kind = "one"',
    '\tKindTwo Kind = "two"',
    ')',
    '',
    'type Sample struct {',
    '\tName    string   `json:"name,omitempty"`',
    '\tKind    Kind     `json:"kind"`',
    '\tItems   []string `json:"items"`',
    '\tManaged *string  `json:"managed"`',
    '}',
  ].join('\n');
  // Member maps key by JSON tag (the wire name), not the Go identifier.
  const s = parseGoTypes([src]).Sample;
  assert.equal(s.name.optional, true);
  assert.equal(s.kind.token, 'enum(["one","two"])');
  assert.equal(s.kind.optional, false);
  assert.equal(s.items.token, 'array<string>');
  assert.equal(s.items.optional, false, 'bare slice is a REQUIRED array');
  assert.equal(s.managed.optional, false, 'pointer without omitempty is required-nullable');
  assert.equal(s.managed.token, 'string|null');
});

test('parseJavaTypes: javadoc between components must not drop fields', () => {
  const src = 'public record Sample(\n    String id,\n    /** documented */\n    Long count) {}\n';
  const types = parseJavaTypes([src]);
  assert.deepEqual(Object.keys(types.Sample), ['id', 'count']);
  assert.equal(types.Sample.count.token, 'number');
});

test('parsePythonTypes: a Literal of bare numbers is an enum, not an unreadable token', () => {
  const src = [
    'StatusFont = Literal[0, 1, 2, 6, 10]',
    '',
    'class Post(TypedDict, total=False):',
    '    font: StatusFont',
  ].join('\n');
  // Members went unread before, so the field fell through to a non-simple token and comparePair
  // skipped it: the enum silently stopped being gated while the run stayed green.
  assert.equal(parsePythonTypes(src).Post.font.token, 'enum([0,1,2,6,10])', 'sorted numerically, not 0,1,10,2,6');
});

test('parseGoTypes: a const block of bare numbers is an enum', () => {
  const src = [
    'type Window int',
    '',
    'const (',
    '\tWindowDay   Window = 86400',
    '\tWindowWeek  Window = 604800',
    '\tWindowMonth Window = 2592000 // thirty days',
    ')',
    '',
    'type Sample struct {',
    '\tWindow Window `json:"window"`',
    '}',
  ].join('\n');
  assert.equal(parseGoTypes([src]).Sample.window.token, 'enum([86400,604800,2592000])');
});

test('parseJavaTypes: enum constants resolve to their wire values, annotated or bare', () => {
  const src = [
    'public enum Scheme {',
    '    @SerializedName("socks5")',
    '    SOCKS5,',
    '    @SerializedName("http")',
    '    HTTP',
    '}',
    'public enum Plain {',
    '    RED,',
    '    BLUE',
    '}',
    'public record Sample(Scheme scheme, List<Plain> shades) {}',
  ].join('\n');
  const s = parseJavaTypes([src]).Sample;
  // Gson emits @SerializedName when present and the constant name otherwise; without this the
  // component resolved to the Java type name, which comparePair skips as non-simple.
  assert.equal(s.scheme.token, 'enum(["http","socks5"])');
  assert.equal(s.shades.token, 'array<enum(["BLUE","RED"])>');
});

test('parseJavaTypes: a bare UNKNOWN sentinel is not a wire member, an annotated "unknown" is', () => {
  const src = [
    'public enum Status {',
    '    @SerializedName("ready") READY,',
    '    /** Decoded when the gateway sends a newer value. */',
    '    UNKNOWN',
    '}',
    'public enum Kind {',
    '    @SerializedName("chat") CHAT,',
    '    @SerializedName("unknown") UNKNOWN',
    '}',
    'public record Sample(Status status, Kind kind) {}',
  ].join('\n');
  const s = parseJavaTypes([src]).Sample;
  assert.equal(s.status.token, 'enum(["ready"])');
  assert.equal(s.kind.token, 'enum(["chat","unknown"])');
});

test('isSimpleToken-gated diffing reaches inside an array of enum members', () => {
  const hand = { events: { optional: false, token: 'array<enum(["a","b"])>' } };
  const schema = {
    type: 'object',
    required: ['events'],
    properties: { events: { type: 'array', items: { enum: ['a', 'c'] } } },
  };
  const diffs = comparePair('Hand', hand, 'Dto', schema, {});
  assert.equal(diffs.length, 1, 'a vocabulary that travels as a list must still be compared');
  assert.match(diffs[0], /events/);
});

test('a nullable enum is compared on both sides, the null member of the contract enum set aside', () => {
  // OpenAPI 3.0 lists null among the members of a nullable enum; the vocabulary is the other members.
  // The token used to end in `|null`, which no comparison accepted, so such a field was never compared.
  const kind = { type: 'string', nullable: true, enum: ['a', 'b', null] };
  const schema = { type: 'object', required: ['kind'], properties: { kind } };
  assert.equal(schemaToken(kind, {}), 'enum(["a","b"])|null');
  assert.equal(handToken("'b' | 'a' | null", {}), 'enum(["a","b"])|null');

  const hand = { kind: { optional: false, token: "'a' | 'b' | null" } };
  assert.deepEqual(comparePair('Hand', hand, 'Dto', schema, {}), []);
  // A member the contract gained, and a null arm the hand lacks, are drift.
  const gained = { ...schema, properties: { kind: { ...kind, enum: ['a', 'b', 'c', null] } } };
  assert.deepEqual(comparePair('Hand', hand, 'Dto', gained, {}), [
    '"kind": hand enum(["a","b"])|null, contract enum(["a","b","c"])|null',
  ]);
  const notNull = { kind: { optional: false, token: "'a' | 'b'" } };
  assert.deepEqual(comparePair('Hand', notNull, 'Dto', schema, {}), [
    '"kind": hand enum(["a","b"]), contract enum(["a","b"])|null',
  ]);
});

test('a nullable array is compared on both sides', () => {
  const ids = { type: 'array', items: { type: 'string' }, nullable: true };
  const schema = { type: 'object', required: ['ids'], properties: { ids } };
  assert.deepEqual(comparePair('Hand', { ids: { optional: false, token: 'string[] | null' } }, 'Dto', schema, {}), []);
  assert.deepEqual(comparePair('Hand', { ids: { optional: false, token: 'string[]' } }, 'Dto', schema, {}), [
    '"ids": hand array<string>, contract array<string>|null',
  ]);
});

test('parsePythonTypes: a nullable Literal or list keeps its closing bracket and gains a null arm', () => {
  const src = [
    'class Sample(TypedDict):',
    '    a: Literal["x", "y"] | None',
    '    b: Optional[Literal["x", "y"]]',
    '    c: list[str] | None',
    '    d: Optional[List[str]]',
    '    e: str | None',
  ].join('\n');
  // The `| None` form lost its last bracket to the strip meant for Optional[...], so `Literal["x", "y"] | None`
  // read as the unparseable `Literal["x", "y"` and the field was never compared.
  const tokens = Object.values(parsePythonTypes(src).Sample).map(v => v.token);
  assert.deepEqual(tokens, [
    'enum(["x","y"])|null',
    'enum(["x","y"])|null',
    'array<string>|null',
    'array<string>|null',
    'string|null',
  ]);
});

test('parseJavaTypes: a package-qualified generic is the same shape as the bare one', () => {
  // Two request records spell the mentions list `java.util.List<String>`; matching only `List<...>`
  // left it resolving to its raw text, so its type went uncompared while the field still counted
  // as present.
  const src = 'public record Sample(java.util.List<String> mentions, List<String> tags) {}';
  const s = parseJavaTypes([src]).Sample;
  assert.equal(s.mentions.token, 'array<string>');
  assert.equal(s.tags.token, s.mentions.token);
});

test('parseJavaTypes: a generic carrying a comma is one component, not two', () => {
  // A plain split(',') tore `Map<String, Object> config` in half: the first piece was unparseable
  // and dropped, the second parsed as type `Object>` under the right field name, so the member
  // survived carrying a token nothing could compare.
  const src = 'public record Sample(String name, Map<String, Object> config, String tail) {}';
  const s = parseJavaTypes([src]).Sample;
  assert.deepEqual(Object.keys(s), ['name', 'config', 'tail']);
  assert.equal(s.config.token, 'dict');
});

test('parseJavaTypes: boxed numerics reduce to number rather than their class name', () => {
  // `Double` fell through to the bare class name, which is not a simple token, so comparePair
  // skipped the field: a Double component against a string contract reported nothing.
  const s = parseJavaTypes(['public record Sample(Double a, Float b, Short c, Byte d) {}']).Sample;
  assert.deepEqual(
    Object.values(s).map(v => v.token),
    ['number', 'number', 'number', 'number'],
  );
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
  assert.equal(comparePair('Sample', { a: s.a }, 'Dto', schema, {}, false).length, 1);
});

test('a run through a symlinked path still reports', () => {
  // Node realpaths the main module's URL but not argv[1], so a guard comparing the unresolved path
  // skipped every check and exited 0 whenever the invocation crossed a symlink (/tmp on macOS).
  const dir = mkdtempSync(join(tmpdir(), 'contract-shapes-'));
  try {
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(dir, 'repo'));
    const run = spawnSync(process.execPath, [join(dir, 'repo', 'scripts', 'check-contract-shapes.mjs')], {
      encoding: 'utf8',
    });
    assert.match(run.stdout + run.stderr, /pairs compared/);
    assert.match(run.stdout + run.stderr, /schema coverage: \d+ schemas/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = schema => ({ content: { 'application/json': { schema } } });
const coverageSpec = {
  paths: {
    '/api/sessions/{sessionId}/labels': {
      parameters: [{ name: 'sessionId', in: 'path' }],
      get: { responses: { 200: json({ type: 'array', items: ref('LabelDto') }), 400: json(ref('ErrorResponse')) } },
    },
    '/api/sessions/{sessionId}/status': {
      post: {
        requestBody: json(ref('PostDto')),
        responses: { 201: json(ref('StatusResultDto')), 404: { $ref: '#/components/responses/NotFound' } },
      },
    },
    '/api/audit': { get: { responses: { 200: json(ref('AuditDto')) } } },
  },
  components: {
    schemas: {
      LabelDto: { type: 'object', properties: { hexColor: { type: 'string' } } },
      PostDto: { type: 'object', properties: { text: { type: 'string' } } },
      StatusResultDto: { type: 'object', properties: { contact: { allOf: [ref('ContactDto')] } } },
      ContactDto: { type: 'object', properties: { id: { type: 'string' } } },
      ErrorResponse: { type: 'object', properties: { detail: ref('ErrorDetail') } },
      ErrorDetail: { type: 'object', properties: {} },
      AuditDto: { type: 'object', properties: {} },
    },
  },
};

test('exposedSchemas follows nested refs from bodies and 2xx responses only, inside the exposed resources', () => {
  // ContactDto is only reachable through StatusResultDto.contact: a nested shape is ungated unless it is
  // asked for too. The error envelope, a resource the README leaves out and a non-schema ref are not.
  const found = exposedSchemas(coverageSpec, new Set(['audit']));
  assert.deepEqual([...found].sort(), ['ContactDto', 'LabelDto', 'PostDto', 'StatusResultDto']);
});

test('schemaCoverageProblems fails when the mapping that held a schema is deleted', () => {
  const exposed = exposedSchemas(coverageSpec, new Set(['audit']));
  const compared = new Set(['LabelDto', 'PostDto', 'StatusResultDto', 'ContactDto']);
  assert.deepEqual(schemaCoverageProblems(exposed, compared, {}), []);
  compared.delete('LabelDto');
  const problems = schemaCoverageProblems(exposed, compared, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^LabelDto .*no client compares it/);
});

test('schemaCoverageProblems accepts a recorded schema and rejects a record that went stale', () => {
  const exposed = new Set(['AckDto', 'LabelDto']);
  const compared = new Set(['LabelDto']);
  assert.deepEqual(schemaCoverageProblems(exposed, compared, { AckDto: 'shared ack type' }), []);
  const stale = schemaCoverageProblems(exposed, compared, { AckDto: 'x', LabelDto: 'x', GoneDto: 'x' });
  assert.equal(stale.length, 2);
  assert.ok(stale.some(p => /LabelDto.*now compares/.test(p)));
  assert.ok(stale.some(p => /GoneDto.*no exposed operation/.test(p)));
});

test('exposedSchemas reads a README entry with a sub-path as a path prefix, not as the whole resource', () => {
  // sdk/README.md lists `auth/api-keys` and says key validation itself is exposed. Unexposing the resource
  // `auth` dropped POST /api/auth/validate too, so its response schema was never required to be compared.
  // `automation` unexposes the automation-rules routes, whose segment carries a suffix.
  const spec = {
    paths: {
      '/api/auth/validate': { post: { responses: { 200: json(ref('ValidateDto')) } } },
      '/api/auth/api-keys': { post: { requestBody: json(ref('KeyBodyDto')), responses: { 201: json(ref('KeyDto')) } } },
      '/api/auth/api-keys/{id}': { get: { responses: { 200: json(ref('KeyDto')) } } },
      '/api/auth/api-keys-other': { get: { responses: { 200: json(ref('OtherDto')) } } },
      '/api/sessions/{sessionId}/automation-rules': { get: { responses: { 200: json(ref('RuleDto')) } } },
    },
    components: {
      schemas: Object.fromEntries(
        ['ValidateDto', 'KeyBodyDto', 'KeyDto', 'OtherDto', 'RuleDto'].map(name => [name, { type: 'object' }]),
      ),
    },
  };
  // OtherDto stays: a prefix ends at a path segment, so `auth/api-keys` does not cover `auth/api-keys-other`.
  const found = exposedSchemas(spec, new Set(['auth/api-keys', 'automation']));
  assert.deepEqual([...found].sort(), ['OtherDto', 'ValidateDto']);
});

test('unexposedResources reads the README paragraph as written and refuses a README it cannot read', () => {
  const names = ['docs', 'auth/api-keys', 'audit', 'settings', 'stats', 'automation', 'infra', 'plugins'];
  // The real README follows `auth/api-keys` with a remark that names the `auth` row of its table.
  const readme = `> Deliberately **not** exposed: \`docs\`, \`auth/api-keys\` (key validation itself is the \`auth\` row above), ${names
    .slice(2)
    .map(n => `\`${n}\``)
    .join(', ')}.\n> Everything else the gateway publishes is exposed.`;
  // `auth/api-keys` stays whole: the entry is a path under /api/auth, not the resource `auth`.
  assert.deepEqual([...unexposedResources(readme)], names);
  assert.throws(() => unexposedResources('no such paragraph'), /Deliberately not exposed/);
  assert.throws(
    () => unexposedResources('Deliberately **not** exposed: `docs`. Everything else the gateway publishes'),
    /only 1/,
  );
  // The real README must still parse, or the coverage check has lost its scope: key validation is in it,
  // the key management routes are not.
  const real = unexposedResources(readFileSync(fileURLToPath(new URL('../sdk/README.md', import.meta.url)), 'utf8'));
  assert.ok(real.has('audit'));
  assert.ok(real.has('auth/api-keys') && !real.has('auth'));
  const openapi = JSON.parse(readFileSync(fileURLToPath(new URL('../openapi.json', import.meta.url)), 'utf8'));
  const exposed = exposedSchemas(openapi, real);
  assert.ok(exposed.has('ValidateApiKeyResponseDto'));
  assert.ok(!exposed.has('ApiKeyCreatedResponseDto'));
});

const gateRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * One run of the gate's CLI on a throwaway root. The gate resolves everything from its own location, so it
 * runs as a copy of itself beside a copy of the contract and of the dashboard types, with the real SDK
 * sources linked in. A hook receives the original text (the parsed contract for `contract`) and returns the
 * one to use. Every file is read with LF endings, so a hook anchors the same text on any checkout, and
 * written with `lineEnding`: '\r\n' also copies the SDK sources the gate reads, as a Windows checkout has them.
 * `sdk` maps a path under the repository (`sdk/go/types_group.go`) to such a hook for one SDK source, which
 * also makes the run copy the SDK sources instead of linking them.
 */
function runGateOnCopy({
  script = s => s,
  contract = c => c,
  dashboardTypes = s => s,
  lineEnding = '\n',
  sdk = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'contract-shapes-copy-'));
  const read = (...path) => readFileSync(join(gateRoot, ...path), 'utf8').replace(/\r\n/g, '\n');
  const write = (path, text) => {
    mkdirSync(join(dir, ...path.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...path), text.replace(/\n/g, lineEnding));
  };
  try {
    if (lineEnding === '\n' && !Object.keys(sdk).length) {
      symlinkSync(join(gateRoot, 'sdk'), join(dir, 'sdk'));
    } else {
      const modelDir = ['sdk', 'java', 'src', 'main', 'java', 'com', 'rmyndharis', 'openwa', 'model'];
      const sources = [
        ['sdk', 'README.md'],
        ['sdk', 'javascript', 'src', 'types.ts'],
        ['sdk', 'python', 'openwa', 'types.py'],
        ...readdirSync(join(gateRoot, 'sdk', 'go'))
          .filter(f => f.endsWith('.go') && !f.endsWith('_test.go'))
          .map(f => ['sdk', 'go', f]),
        ...readdirSync(join(gateRoot, ...modelDir))
          .filter(f => f.endsWith('.java'))
          .map(f => [...modelDir, f]),
      ];
      for (const path of sources) write(path, (sdk[path.join('/')] ?? (text => text))(read(...path)));
      for (const path of Object.keys(sdk)) {
        assert.ok(
          sources.some(s => s.join('/') === path),
          `${path} is not an SDK source the gate reads`,
        );
      }
    }
    write(['scripts', 'check-contract-shapes.mjs'], script(read('scripts', 'check-contract-shapes.mjs')));
    write(
      ['openapi.json'],
      JSON.stringify(contract(JSON.parse(read('openapi.json'))), null, lineEnding === '\n' ? 0 : 2),
    );
    write(['dashboard', 'src', 'services', 'api.ts'], dashboardTypes(read('dashboard', 'src', 'services', 'api.ts')));
    const run = spawnSync(process.execPath, [join(dir, 'scripts', 'check-contract-shapes.mjs')], { encoding: 'utf8' });
    return { status: run.status, output: run.stdout + run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replace text in the gate source, failing loudly when the anchor has moved. */
function editSource(source, from, to) {
  assert.ok(source.includes(from), `the gate source no longer contains ${JSON.stringify(from)}: move this anchor`);
  return source.replace(from, to);
}

/** One more exposed route, answering a payload that no client maps. */
function withBrandNewPayload(contract) {
  contract.components.schemas.BrandNewDto = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  };
  contract.paths['/api/sessions/{sessionId}/brand-new'] = {
    get: { responses: { 200: { description: 'ok', ...json(ref('BrandNewDto')) } } },
  };
  return contract;
}

test('the gate exits 0 on the repository and finds every exposed schema covered', () => {
  // Also pins the harness below: a copy that cannot run would fail the other cases for the wrong reason.
  // A pair whose target is a list (a body type that is also its response) has to reach the comparison and
  // the coverage set as the schemas it names.
  const run = runGateOnCopy();
  assert.equal(run.status, 0, run.output);
  assert.match(
    run.output,
    /schema coverage: \d+ schemas sent or returned, \d+ recorded unmapped in UNMAPPED_SCHEMAS, all covered/,
  );
});

test('the gate exits 1 and names an exposed payload that no client maps', () => {
  const run = runGateOnCopy({ contract: withBrandNewPayload });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /BrandNewDto is sent or returned by the SDKs but no client compares it/);
  assert.match(run.output, /schema coverage: .*FAILURES/);
});

test('a schema that only the dashboard compares, or only an excluded pair holds, is reported uncovered', () => {
  // The dashboard types are not a client of the SDK promise: BrandNewDto is compared there and still reported.
  const dashboardOnly = runGateOnCopy({
    contract: withBrandNewPayload,
    dashboardTypes: api => `${api}\nexport interface BrandNew {\n  id: string;\n}\n`,
    script: source =>
      editSource(
        source,
        "  'dashboard/src/services/api.ts': {\n    AccountRestriction: 'AccountRestrictionDto',",
        "  'dashboard/src/services/api.ts': {\n    BrandNew: 'BrandNewDto',\n    AccountRestriction: 'AccountRestrictionDto',",
      ),
  });
  assert.match(dashboardOnly.output, /dashboard\/src\/services\/api\.ts: \d+ pairs compared, all conform/);
  assert.equal(dashboardOnly.status, 1, dashboardOnly.output);
  assert.match(dashboardOnly.output, /BrandNewDto is sent or returned by the SDKs but no client compares it/);

  // The Go client excludes its MembershipRequestActionRequest pair and the Java client compares it; with the
  // Java pair excluded too, no client compares MembershipRequestActionDto, and an excluded pair compares nothing.
  const excludedOnly = runGateOnCopy({
    script: source =>
      editSource(
        source,
        "  'sdk/java': {\n    UpdateSessionConfigRequest:",
        "  'sdk/java': {\n    MembershipRequestActionRequest: 'held back for this run',\n    UpdateSessionConfigRequest:",
      ),
  });
  assert.equal(excludedOnly.status, 1, excludedOnly.output);
  assert.match(
    excludedOnly.output,
    /MembershipRequestActionDto is sent or returned by the SDKs but no client compares it/,
  );
});

const javaModel = 'sdk/java/src/main/java/com/rmyndharis/openwa/model';

test('an excluded pair with a looser field type is still compared by field name', () => {
  // Each pair keeps a plain string (or a pointer) where the contract is stricter, so it is excluded from the
  // full comparison. Renaming one wire field in the hand type must still fail the run, naming the pair.
  const rename = (from, to) => text => editSource(text, from, to);
  const cases = [
    ['sdk/go/types_contact.go', 'ContactRecord ↔ ContactDto', 'json:"isBlocked"', 'json:"isBlockedd"', 'isBlockedd'],
    [
      'sdk/go/types_group.go',
      'GroupPictureResponse ↔ GroupPictureResponseDto',
      'URL string `json:"url"`',
      'URL string `json:"uri"`',
      'uri',
    ],
    [
      'sdk/go/types_group.go',
      'GroupSettings ↔ GroupSettingsResponseDto',
      'MemberAddMode *string `json:"memberAddMode,omitempty"`',
      'MemberAddMode *string `json:"memberAddmode,omitempty"`',
      'memberAddmode',
    ],
    [
      'sdk/go/types_status.go',
      'StatusRecord ↔ StatusDto',
      'json:"backgroundColor,omitempty"',
      'json:"backgroundColour,omitempty"',
      'backgroundColour',
    ],
    [
      'sdk/go/types_misc.go',
      'AuthValidateResponse ↔ ValidateApiKeyResponseDto',
      'json:"engineType,omitempty"',
      'json:"engine,omitempty"',
      'engine',
    ],
    [
      `${javaModel}/GroupSettings.java`,
      'GroupSettings ↔ GroupSettingsResponseDto',
      'String memberAddMode) {',
      'String memberAddModes) {',
      'memberAddModes',
    ],
    [
      `${javaModel}/StatusRecord.java`,
      'StatusRecord ↔ StatusDto',
      '    String backgroundColor,',
      '    String backgroundColour,',
      'backgroundColour',
    ],
    [
      `${javaModel}/AuthValidateResponse.java`,
      'AuthValidateResponse ↔ ValidateApiKeyResponseDto',
      'String engineType,',
      'String engine,',
      'engine',
    ],
  ];
  for (const [path, pair, from, to, renamed] of cases) {
    const run = runGateOnCopy({ sdk: { [path]: rename(from, to) } });
    assert.equal(run.status, 1, `${path}: ${run.output}`);
    assert.ok(run.output.includes(`${pair}:`), `${path} did not fail on ${pair}: ${run.output}`);
    assert.match(run.output, new RegExp(`hand has "${renamed}"`), path);
  }
});

test('the gate refuses a NAMES_ONLY entry whose pair is not excluded', () => {
  // An entry left behind after a pair is retyped and un-excluded would keep the weaker name-only comparison.
  const run = runGateOnCopy({
    script: source =>
      editSource(source, "  'sdk/java': ['GroupSettings',", "  'sdk/java': ['ContactRecord', 'GroupSettings',"),
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /ContactRecord is in NAMES_ONLY but not in EXCLUDED/);
});

test('the gate and its CLI cases give the same verdicts on a CRLF checkout', () => {
  // A Windows checkout holds every file with CRLF endings: the parsers, the README reading and the anchors of
  // these cases must not depend on them. The existing case above covers the parsers on strings only.
  const clean = runGateOnCopy({ lineEnding: '\r\n' });
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.output, /schema coverage: .*all covered/);

  const dashboardOnly = runGateOnCopy({
    lineEnding: '\r\n',
    contract: withBrandNewPayload,
    dashboardTypes: api => `${api}\nexport interface BrandNew {\n  id: string;\n}\n`,
    script: source =>
      editSource(
        source,
        "  'dashboard/src/services/api.ts': {\n    AccountRestriction: 'AccountRestrictionDto',",
        "  'dashboard/src/services/api.ts': {\n    BrandNew: 'BrandNewDto',\n    AccountRestriction: 'AccountRestrictionDto',",
      ),
  });
  assert.equal(dashboardOnly.status, 1, dashboardOnly.output);
  assert.match(dashboardOnly.output, /BrandNewDto is sent or returned by the SDKs but no client compares it/);
});

test('enum comparison preserves number, string and boolean wire kinds in every client parser', () => {
  const sample = {
    typescript: (a, b) => parseHandTypes(`export interface Sample {\n  value: '${a}' | '${b}';\n}\n`).Sample,
    python: (a, b) => parsePythonTypes(`class Sample(TypedDict):\n    value: Literal["${a}", "${b}"]\n`).Sample,
    go: (a, b) =>
      parseGoTypes([
        `type Kind string\nconst (\n One Kind = "${a}"\n Two Kind = "${b}"\n)\ntype Sample struct {\n Value Kind \x60json:"value"\x60\n}\n`,
      ]).Sample,
    java: (a, b) =>
      parseJavaTypes([
        `public enum Kind {\n @SerializedName("${a}") ONE,\n @SerializedName("${b}") TWO\n}\npublic record Sample(Kind value) {}\n`,
      ]).Sample,
  };
  for (const [language, parse] of Object.entries(sample)) {
    for (const values of [
      [0, 1],
      [false, true],
    ]) {
      const hand = parse(...values.map(String));
      const dto = members => ({
        type: 'object',
        required: ['value'],
        properties: { value: { type: typeof members[0], enum: members } },
      });
      assert.deepEqual(comparePair('Sample', hand, 'Dto', dto(values.map(String)), {}, language !== 'java'), []);
      assert.ok(comparePair('Sample', hand, 'Dto', dto(values), {}, language !== 'java').length > 0, language);
      const arrayHand = {
        value: {
          ...hand.value,
          token: `array<${language === 'typescript' ? handToken(hand.value.token, {}) : hand.value.token}>`,
        },
      };
      const arrayDto = {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'array', items: { type: typeof values[0], enum: values } } },
      };
      assert.ok(
        comparePair('Sample', arrayHand, 'Dto', arrayDto, {}, language !== 'java').length > 0,
        `${language} array`,
      );
    }
  }
});

test('nullable enum comparisons retain kind and Java numeric loosening accepts only numeric members', () => {
  const dto = value => ({ type: 'object', required: ['value'], properties: { value } });
  const numeric = dto({ type: 'number', enum: [0, 1, null], nullable: true });
  const strings = dto({ type: 'string', enum: ['0', '1', null], nullable: true });
  const hand = { value: { optional: false, token: "'0' | '1' | null" } };
  assert.deepEqual(comparePair('Sample', hand, 'Dto', strings, {}), []);
  assert.ok(comparePair('Sample', hand, 'Dto', numeric, {}).length > 0);
  const java = parseJavaTypes(['public record Sample(Integer value) {}']).Sample;
  assert.deepEqual(comparePair('Sample', java, 'Dto', numeric, {}, false), []);
  assert.ok(comparePair('Sample', java, 'Dto', strings, {}, false).length > 0);
});

test('TypeScript double-quoted numeric strings remain strings and JSON enum punctuation preserves later fields', () => {
  const numeric = { type: 'object', required: ['value'], properties: { value: { type: 'number', enum: [0, 1] } } };
  const hand = parseHandTypes('export interface Sample {\n  value: "0" | "1";\n}\n').Sample;
  assert.ok(comparePair('Sample', hand, 'Dto', numeric, {}).length > 0);
  const value = 'a),<"b';
  const schema = {
    type: 'object',
    required: ['value', 'tail'],
    properties: { value: { type: 'string', enum: [value] }, tail: { type: 'boolean' } },
  };
  const fields = parseObjectToken(schemaToken(schema, {}));
  assert.deepEqual(Object.keys(fields), ['tail', 'value']);
  assert.equal(fields.tail.token, 'boolean');
});

test('the CLI refuses numeric status fonts declared as strings in every typed SDK', () => {
  const edit = (s, a, b) => {
    assert.ok(s.includes(a));
    return s.replace(a, b);
  };
  const cases = [
    [
      'sdk/javascript/src/types.ts',
      s => edit(s, 'font?: 0 | 1 | 2 | 6 | 7 | 8 | 9 | 10;', "font?: '0' | '1' | '2' | '6' | '7' | '8' | '9' | '10';"),
    ],
    [
      'sdk/python/openwa/types.py',
      s =>
        edit(
          s,
          'StatusFont = Literal[0, 1, 2, 6, 7, 8, 9, 10]',
          'StatusFont = Literal["0", "1", "2", "6", "7", "8", "9", "10"]',
        ),
    ],
    [
      'sdk/go/types_status.go',
      s =>
        edit(s, 'type StatusFont int', 'type StatusFont string').replace(
          /(StatusFont\s*=\s*)(\d+)(\s*(?:\/\/[^\n]*)?\n)/g,
          '$1"$2"$3',
        ),
    ],
    [
      `${javaModel}/SendTextStatusRequest.java`,
      () => `package com.rmyndharis.openwa.model;
import java.util.List;
import com.google.gson.annotations.SerializedName;
public record SendTextStatusRequest(String text, List<String> recipients, String backgroundColor, FixtureFont font) {
  public enum FixtureFont {
    @SerializedName("0") F0, @SerializedName("1") F1, @SerializedName("2") F2,
    @SerializedName("6") F6, @SerializedName("7") F7, @SerializedName("8") F8,
    @SerializedName("9") F9, @SerializedName("10") F10
  }
}
`,
    ],
  ];
  for (const [path, mutate] of cases) {
    const result = runGateOnCopy({ sdk: { [path]: mutate } });
    assert.equal(result.status, 1, `${path}: ${result.output}`);
    assert.match(result.output, /SendTextStatusRequest/);
    assert.match(result.output, /font/);
  }
});

for (const [name, value] of [
  ['empty', { type: 'number', enum: [] }],
  ['null-only', { type: 'number', enum: [null], nullable: true }],
]) {
  test(`Java numeric relaxation refuses a ${name} enum`, () => {
    const java = parseJavaTypes(['public record Sample(Integer value) {}']).Sample;
    const schema = { type: 'object', required: ['value'], properties: { value } };
    assert.ok(comparePair('Sample', java, 'Dto', schema, {}, false).length > 0);
    const numeric = { ...schema, properties: { value: { type: 'number', enum: [0, 1] } } };
    assert.deepEqual(comparePair('Sample', java, 'Dto', numeric, {}, false), []);
  });
}
