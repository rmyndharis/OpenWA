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
import {
  comparePair,
  handToken,
  parseGoTypes,
  parseHandTypes,
  parseJavaTypes,
  parseObjectToken,
  parsePythonTypes,
  schemaToken,
} from './check-contract-shapes.mjs';

const handSource = `
export interface Sample {
  id: string;
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
  assert.ok(diffs.some(d => d.includes('"direction": hand string, contract enum(incoming,outgoing)')));
  assert.ok(diffs.some(d => d.includes('"count": hand number|null, contract number')));
});

test('parseObjectToken splits nested object tokens without losing members', () => {
  const members = parseObjectToken('object(id:string,sub:object(a:number,b?:boolean),tail:string)');
  assert.deepEqual(Object.keys(members), ['id', 'sub', 'tail']);
  assert.equal(members.b?.optional ?? parseObjectToken(members.sub.token).b.optional, true);
});

test('handToken reduces enums, null unions and arrays deterministically', () => {
  const types = {};
  assert.equal(handToken("'b' | 'a'", types), 'enum(a,b)'.replace(',', ','));
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
  assert.equal(types.Session.status.token, 'enum(created,ready)');
  assert.equal(types.Session.lastError.optional, true);
  assert.equal(types.Session.lastError.token, 'string|null');
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
  assert.equal(s.kind.token, 'enum(one,two)');
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
  assert.equal(parsePythonTypes(src).Post.font.token, 'enum(0,1,2,6,10)', 'sorted numerically, not 0,1,10,2,6');
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
  assert.equal(parseGoTypes([src]).Sample.window.token, 'enum(86400,604800,2592000)');
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
  assert.equal(s.scheme.token, 'enum(http,socks5)');
  assert.equal(s.shades.token, 'array<enum(BLUE,RED)>');
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
  assert.equal(s.status.token, 'enum(ready)');
  assert.equal(s.kind.token, 'enum(chat,unknown)');
});

test('isSimpleToken-gated diffing reaches inside an array of enum members', () => {
  const hand = { events: { optional: false, token: 'array<enum(a,b)>' } };
  const schema = { type: 'object', required: ['events'], properties: { events: { type: 'array', items: { enum: ['a', 'c'] } } } };
  const diffs = comparePair('Hand', hand, 'Dto', schema, {});
  assert.equal(diffs.length, 1, 'a vocabulary that travels as a list must still be compared');
  assert.match(diffs[0], /events/);
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
