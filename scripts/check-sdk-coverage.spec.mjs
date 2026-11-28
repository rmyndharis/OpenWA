import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinPythonLiterals, undeclaredVerbPairs } from './check-sdk-coverage.mjs';

const specByPath = new Map([
  ['/api/sessions/*/groups/*', { get: {} }],
  ['/api/sessions/*/webhooks/*', { put: {}, delete: {} }],
]);

test('undeclaredVerbPairs flags a verb the contract does not declare on a single-verb path', () => {
  assert.deepEqual(undeclaredVerbPairs('python', new Set(['POST /api/sessions/*/groups/*']), specByPath), [
    'POST /api/sessions/*/groups/*: built by python, not declared by the contract',
  ]);
  assert.deepEqual(undeclaredVerbPairs('python', new Set(['GET /api/sessions/*/groups/*']), specByPath), []);
});

test('undeclaredVerbPairs flags a wrong verb on a multi-verb path', () => {
  const pairs = new Set(['PUT /api/sessions/*/webhooks/*', 'PATCH /api/sessions/*/webhooks/*']);
  assert.deepEqual(undeclaredVerbPairs('go', pairs, specByPath), [
    'PATCH /api/sessions/*/webhooks/*: built by go, not declared by the contract',
  ]);
});

test('undeclaredVerbPairs ignores a pair that is not a contract path', () => {
  assert.deepEqual(undeclaredVerbPairs('javascript', new Set(['POST /api/sessions/*/messages/*']), specByPath), []);
});

test('joinPythonLiterals joins a path split across adjacent literals', () => {
  const expr = 'f"/api/sessions/{a}/groups/{b}"\n            "/membership-requests/approve"';
  assert.equal(joinPythonLiterals(expr), '/api/sessions/{a}/groups/{b}/membership-requests/approve');
});

test('a run through a symlinked path still reports', () => {
  // Node realpaths the main module's URL but not argv[1], so a guard comparing the unresolved path
  // skipped every check and exited 0 whenever the invocation crossed a symlink (/tmp on macOS).
  const dir = mkdtempSync(join(tmpdir(), 'sdk-coverage-'));
  try {
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(dir, 'repo'));
    const run = spawnSync(process.execPath, [join(dir, 'repo', 'scripts', 'check-sdk-coverage.mjs')], {
      encoding: 'utf8',
    });
    assert.match(run.stdout + run.stderr, /SDK contract coverage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the sources the gate reads, so a case can break one of them; `fn` gets an edit helper and a runner. */
function withCopy(fn) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'sdk-coverage-copy-'));
  try {
    for (const path of [
      'scripts/check-sdk-coverage.mjs',
      'scripts/check-contract-shapes.mjs',
      'scripts/sdk-query-parameter-gaps.json',
      'openapi.json',
      'sdk/README.md',
      'sdk/javascript/src',
      'sdk/python/openwa',
      'sdk/php/src',
      'sdk/java/src/main',
      'sdk/go',
    ]) {
      cpSync(join(repo, path), join(dir, path), { recursive: true });
    }
    const run = () =>
      spawnSync(process.execPath, [join(dir, 'scripts', 'check-sdk-coverage.mjs')], { encoding: 'utf8' });
    /** Replace `from` in a copied file, returning a function that puts the original back. */
    const edit = (path, from, to) => {
      const file = join(dir, path);
      const source = readFileSync(file, 'utf8');
      assert.ok(source.includes(from), `${path} no longer contains ${JSON.stringify(from)}: move this anchor`);
      writeFileSync(file, source.replace(from, to));
      return () => writeFileSync(file, source);
    };
    const whole = run();
    assert.equal(whole.status, 0, whole.stdout + whole.stderr);
    fn({ edit, run });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the key validation route is required of every SDK, the key management routes are not', () => {
  // sdk/README.md lists `auth/api-keys` as unexposed and says key validation itself is exposed. The scope used to
  // cut every entry to its first segment, which made all of /api/auth unexposed, so an SDK without its auth()
  // method kept the gate green. The gate runs on a copy of the sources it reads, with the PHP auth() emptied.
  withCopy(({ edit, run }) => {
    edit('sdk/php/src/Client.php', "return $this->http->requestNullableArray('POST', '/api/auth/validate') ?? [];", 'return [];');
    const without = run();
    assert.equal(without.status, 1, without.stdout + without.stderr);
    assert.match(without.stderr, /\/api\/auth\/validate .*built by no method in: php/);
    assert.doesNotMatch(without.stderr, /\/api\/auth\/api-keys/);
  });
});

test('a builder whose last segment is a variable covers only the names its callers pass', () => {
  // Every client builds the send-media routes as `.../messages/${segment}`, and Go builds the membership-request
  // actions as `.../membership-requests/" + verb`. Such a wildcard must not stand in for every sibling route.
  withCopy(({ edit, run }) => {
    const missing = (output, route, clients) =>
      assert.match(output, new RegExp(`${route.replace(/\*/g, '\\*')} .*built by no method in: ${clients}$`, 'm'));

    // A message route one client stopped building.
    let restore = edit(
      'sdk/php/src/Resources/MessagesResource.php',
      'return $this->http->requestArray(\'POST\', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/react", [], $body);',
      'return [];',
    );
    let result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    missing(result.stderr, '/api/sessions/*/messages/react', 'php');
    restore();

    // A send-media verb one client no longer passes to its builder.
    restore = edit(
      'sdk/javascript/src/resources/messages.ts',
      "sendMedia(sessionId, 'send-sticker',",
      "sendMedia(sessionId, 'send-image',",
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    missing(result.stderr, '/api/sessions/*/messages/send-sticker', 'javascript');
    restore();

    // New routes no client builds at all, in both builder families.
    restore = edit(
      'openapi.json',
      '"paths": {',
      '"paths": {"/api/sessions/{sessionId}/messages/send-brand-new":{"post":{"responses":{"201":{"description":"ok"}}}},' +
        '"/api/sessions/{sessionId}/groups/{groupId}/membership-requests/brand-new":{"post":{"responses":{"201":{"description":"ok"}}}},',
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    missing(result.stderr, '/api/sessions/*/messages/send-brand-new', 'javascript, python, php, java, go');
    missing(
      result.stderr,
      '/api/sessions/*/groups/*/membership-requests/brand-new',
      'javascript, python, php, java, go',
    );
    restore();
  });
});

test('stale routes in Go and Java fail the coverage gate, including wildcards, path vars, and doRaw', () => {
  withCopy(({ edit, run }) => {
    let restore = edit('sdk/go/calls.go', '"/reject"', '"/reject-stale"');
    let result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /\/api\/sessions\/\*\/calls\/\*\/reject-stale: built by go/);
    restore();

    restore = edit(
      'sdk/java/src/main/java/com/rmyndharis/openwa/resources/CallsResource.java',
      '"/reject"',
      '"/reject-stale"',
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /\/api\/sessions\/\*\/calls\/\*\/reject-stale: built by java/);
    restore();

    // Wildcard-ending by-id routes (/*) must be verified against the contract, not skipped.
    restore = edit('sdk/go/catalog.go', '"/catalog/products/"', '"/catalog/stale-products/"');
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /\/api\/sessions\/\*\/catalog\/stale-products\/\*: built by go/);
    restore();

    restore = edit(
      'sdk/java/src/main/java/com/rmyndharis/openwa/resources/CatalogResource.java',
      '"/catalog/products/"',
      '"/catalog/stale-products/"',
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /\/api\/sessions\/\*\/catalog\/stale-products\/\*: built by java/);
    restore();

    // Go local `path :=` route variables and `.doRaw(...)` calls must also be checked.
    restore = edit(
      'sdk/go/chats.go',
      'path := s.base(sessionID) + "/" + pathEscape(chatID) + "/messages"',
      'path := s.base(sessionID) + "/" + pathEscape(chatID) + "/messages-stale"',
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /DELETE \/api\/sessions\/\*\/chats\/\*\/messages-stale: built by go/);
    restore();

    restore = edit('sdk/go/status.go', '+pathEscape(statusID)+"/media"', '+pathEscape(statusID)+"/media-stale"');
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/status\/\*\/media-stale: built by go/);
    restore();

    restore = edit(
      'sdk/go/messages.go',
      'path := s.base(sessionID) + "/" + pathEscape(chatID) + "/" + pathEscape(messageID) + "/media"',
      'path := s.base(sessionID) + "/" + pathEscape(chatID) + "/" + pathEscape(messageID) + "/media-stale"',
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/messages\/\*\/\*\/media-stale: built by go/);
    restore();

    // Local named `webhooks` must NOT rewrite `"/webhooks/"` inside string literals.
    restore = edit(
      'sdk/go/webhooks.go',
      'err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(webhookID), nil, nil, &out)',
      'webhooks := "custom"\n\t_ = webhooks\n\terr := s.client.do(ctx, "GET", "/api/sessions/"+pathEscape(sessionID)+"/webhooks/"+pathEscape(webhookID), nil, nil, &out)',
    );
    result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    restore();

    // Chained, multi-line, and conditional-branch Go locals must all be resolved and flagged when stale.
    restore = edit(
      'sdk/go/catalog.go',
      'err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)',
      [
        'prefix := s.sessionBase(sessionID) +',
        '\t\t"/catalog"',
        '\tpath := prefix + "/products"',
        '\tif query != nil {',
        '\t\tpath = prefix + "/products-stale"',
        '\t}',
        '\terr := s.client.do(ctx, "GET", path, valuesOf(query), nil, &out)',
      ].join('\n\t'),
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog\/products-stale: built by go/);
    restore();

    // Java local `String` route variables (chained and conditional) must also be caught when stale.
    restore = edit(
      'sdk/java/src/main/java/com/rmyndharis/openwa/resources/CatalogResource.java',
      'public CatalogInfo info(String sessionId) {\n        return client.request(\n            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/catalog", null, null, CatalogInfo.class);',
      [
        'public CatalogInfo info(String sessionId) {',
        '        String base = "/api/sessions/" + encodeSegment(sessionId);',
        '        String path = base + "/catalog";',
        '        if (sessionId.isEmpty()) {',
        '            path = base + "/catalog-stale";',
        '        }',
        '        return client.request(',
        '            HttpMethod.GET, path, null, null, CatalogInfo.class);',
      ].join('\n'),
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog-stale: built by java/);
    restore();
  });
});

test('sequential +=, overwrite, and mutually exclusive if/else branches avoid intermediate and cross-branch false positives', () => {
  withCopy(({ edit, run }) => {
    // Go: sequential +=, path = path + "...", unconditional overwrite, if/else += isolation, and early-return isolation.
    let restore = edit(
      'sdk/go/media.go',
      'err := s.client.do(ctx, "GET", s.base(sessionID)+"/convert", nil, nil, &out)',
      [
        'path := "/api/sessions/" + pathEscape(sessionID) + "/media"',
        '\tpath += "/convert"',
        '\tif len(sessionID) == 0 {',
        '\t\tpath = "/api/sessions/" + pathEscape(sessionID) + "/media"',
        '\t\tpath = path + "/convert"',
        '\t} else if len(sessionID) == 1 {',
        '\t\tpath = s.base(sessionID)',
        '\t\tpath = "/api/sessions/" + pathEscape(sessionID) + "/chats"',
        '\t}',
        '\terr := s.client.do(ctx, "GET", path, nil, nil, &out)',
      ].join('\n\t'),
    );
    let restoreVoice = edit(
      'sdk/go/media.go',
      'err := s.client.do(ctx, "POST", s.base(sessionID)+"/convert/voice", nil, in, &out)',
      [
        'target := s.base(sessionID)',
        '\tif in.URL != "" {',
        '\t\ttarget += "/convert/voice"',
        '\t} else {',
        '\t\ttarget += "/convert/video"',
        '\t}',
        '\terr := s.client.do(ctx, "POST", target, nil, in, &out)',
      ].join('\n\t'),
    );
    let restoreVideo = edit(
      'sdk/go/media.go',
      'err := s.client.do(ctx, "POST", s.base(sessionID)+"/convert/video", nil, in, &out)',
      [
        'early := s.base(sessionID)',
        '\tif in.URL != "" {',
        '\t\tearly += "/convert/voice"',
        '\t\tvar first ConvertedMedia',
        '\t\t_ = s.client.do(ctx, "POST", early, nil, in, &first)',
        '\t\treturn &first, nil',
        '\t}',
        '\tearly += "/convert/video"',
        '\terr := s.client.do(ctx, "POST", early, nil, in, &out)',
      ].join('\n\t'),
    );
    let result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    restoreVideo();
    restoreVoice();
    restore();

    // Java: sequential +=, p = p + "...", overwrite, if/else += isolation, and early-return isolation.
    restore = edit(
      'sdk/java/src/main/java/com/rmyndharis/openwa/resources/MediaResource.java',
      'public ConvertedMedia convertVideo(String sessionId, ConvertMediaRequest media) {',
      [
        'void sequentialHelpers(String sessionId, ConvertMediaRequest media, boolean flag) throws Exception {',
        '        var p = "/api/sessions/" + encodeSegment(sessionId) + "/media";',
        '        p += "/convert";',
        '        if (sessionId.isEmpty()) {',
        '            p = "/api/sessions/" + encodeSegment(sessionId) + "/media";',
        '            p = p + "/convert";',
        '        } else if (sessionId.length() == 1) {',
        '            p = "/api/sessions/" + encodeSegment(sessionId) + "/media";',
        '            p = "/api/sessions/" + encodeSegment(sessionId) + "/chats";',
        '        }',
        '        client.request(HttpMethod.GET, p, null, null, Object.class);',
        '',
        '        String target = "/api/sessions/" + encodeSegment(sessionId) + "/media";',
        '        if (flag) {',
        '            target += "/convert/voice";',
        '        } else {',
        '            target += "/convert/video";',
        '        }',
        '        client.request(HttpMethod.POST, target, null, media, ConvertedMedia.class);',
        '',
        '        var early = "/api/sessions/" + encodeSegment(sessionId) + "/media";',
        '        if (flag) {',
        '            early += "/convert/voice";',
        '            client.request(HttpMethod.POST, early, null, media, ConvertedMedia.class);',
        '            return;',
        '        }',
        '        early += "/convert/video";',
        '        client.request(HttpMethod.POST, early, null, media, ConvertedMedia.class);',
        '    }',
        '',
        '    public ConvertedMedia convertVideo(String sessionId, ConvertMediaRequest media) {',
      ].join('\n'),
    );
    result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    restore();
  });
});

test('stale routes inside Go if/else-if/for init clauses, Go free helpers, and Java package-private/throws/var/unbraced-if are caught', () => {
  withCopy(({ edit, run }) => {
    // Go `if path := ...` init clause + `+=` stale route
    let restore = edit(
      'sdk/go/catalog.go',
      'err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)',
      [
        'if path := s.sessionBase(sessionID) + "/catalog"; query != nil {',
        '\t\tpath += "/if-init-stale"',
        '\t\t_ = s.client.do(ctx, "GET", path, valuesOf(query), nil, &out)',
        '\t}',
        '\terr := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)',
      ].join('\n\t'),
    );
    let result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog\/if-init-stale: built by go/);
    restore();

    // Go `else if path := ...` init clause
    restore = edit(
      'sdk/go/catalog.go',
      'err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)',
      [
        'if query == nil {',
        '\t\t_ = query',
        '\t} else if path := s.sessionBase(sessionID) + "/catalog/else-if-init-stale"; query != nil {',
        '\t\t_ = s.client.do(ctx, "GET", path, valuesOf(query), nil, &out)',
        '\t}',
        '\terr := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)',
      ].join('\n\t'),
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog\/else-if-init-stale: built by go/);
    restore();

    // Go `for path := ...` init clause
    restore = edit(
      'sdk/go/catalog.go',
      'err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)',
      [
        'for path := s.sessionBase(sessionID) + "/catalog/for-init-stale"; false; {',
        '\t\t_ = s.client.do(ctx, "GET", path, valuesOf(query), nil, &out)',
        '\t}',
        '\terr := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)',
      ].join('\n\t'),
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog\/for-init-stale: built by go/);
    restore();

    // Go free helper function with `<ident>.<baseHelper>(...)` and receiverless signature
    restore = edit(
      'sdk/go/catalog.go',
      'func (s *CatalogService) sessionBase(sessionID string) string {',
      [
        'func helperFetchCatalog(ctx context.Context, c *CatalogService, sessionID string) error {',
        '\tpath := c.sessionBase(sessionID) + "/catalog/free-helper-stale"',
        '\treturn c.client.do(ctx, "GET", path, nil, nil, nil)',
        '}',
        '',
        'func (s *CatalogService) sessionBase(sessionID string) string {',
      ].join('\n'),
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog\/free-helper-stale: built by go/);
    restore();

    // Java package-private method with `throws Exception`, `var`, and unbraced `if`/`else`
    restore = edit(
      'sdk/java/src/main/java/com/rmyndharis/openwa/resources/CatalogResource.java',
      'public CatalogInfo info(String sessionId) {',
      [
        'CatalogInfo packageHelper(String sessionId, boolean flag) throws Exception {',
        '        var p = "/api/sessions/" + encodeSegment(sessionId) + "/catalog";',
        '        if (flag) p = p + "-if-stale";',
        '        else p = p + "-else-stale";',
        '        return client.request(HttpMethod.GET, p, null, null, CatalogInfo.class);',
        '    }',
        '',
        '    public CatalogInfo info(String sessionId) {',
      ].join('\n'),
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog-if-stale: built by java/);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog-else-stale: built by java/);
    restore();
  });
});

test('nested control-flow blocks, try/finally after return, and Java Object record params are analyzed accurately', () => {
  withCopy(({ edit, run }) => {
    // Go: nested both-returning if inside outer block prunes unreachable call; nested if/for inside if propagates locals.
    let restore = edit(
      'sdk/go/media.go',
      'err := s.client.do(ctx, "GET", s.base(sessionID)+"/convert", nil, nil, &out)',
      [
        'path := "/api/sessions/" + pathEscape(sessionID) + "/media"',
        '\tif len(sessionID) == 0 {',
        '\t\tif len(sessionID) > 1 {',
        '\t\t\tpath += "/convert/voice"',
        '\t\t\treturn nil, nil',
        '\t\t} else {',
        '\t\t\tpath += "/convert/video"',
        '\t\t\treturn nil, nil',
        '\t\t}',
        '\t\tpath += "/unreachable-stale"',
        '\t}',
        '\tif len(sessionID) == 2 {',
        '\t\tif len(sessionID) > 0 {',
        '\t\t\tpath = "/api/sessions/" + pathEscape(sessionID) + "/media/convert"',
        '\t\t} else {',
        '\t\t\tpath = "/api/sessions/" + pathEscape(sessionID) + "/chats"',
        '\t\t}',
        '\t\treturn nil, s.client.do(ctx, "GET", path, nil, nil, &out)',
        '\t}',
        '\tpath += "/convert"',
        '\terr := s.client.do(ctx, "GET", path, nil, nil, &out)',
      ].join('\n\t'),
    );
    let result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    restore();

    // Java: valid try { nested if/else += } finally {} passes with zero false positives.
    restore = edit(
      'sdk/java/src/main/java/com/rmyndharis/openwa/resources/MediaResource.java',
      'public ConvertedMedia convertVideo(String sessionId, ConvertMediaRequest media) {',
      [
        'void tryNestedHelper(String sessionId, ConvertMediaRequest media, boolean flag) {',
        '        var target = "/api/sessions/" + encodeSegment(sessionId) + "/media";',
        '        try {',
        '            if (flag) {',
        '                if (sessionId.isEmpty()) {',
        '                    target += "/convert/voice";',
        '                    return;',
        '                } else {',
        '                    target += "/convert/video";',
        '                    return;',
        '                }',
        '                target += "/unreachable-stale";',
        '                client.request(HttpMethod.POST, target, null, media, ConvertedMedia.class);',
        '            }',
        '            target += "/convert/voice";',
        '        } finally {',
        '            client.request(HttpMethod.POST, target, null, media, ConvertedMedia.class);',
        '        }',
        '    }',
        '',
        '    public ConvertedMedia convertVideo(String sessionId, ConvertMediaRequest media) {',
      ].join('\n'),
    );
    result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    restore();

    // Go: nested loop/if inside if propagating a stale local route out of block is caught.
    restore = edit(
      'sdk/go/catalog.go',
      'err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)',
      [
        'path := s.sessionBase(sessionID) + "/catalog"',
        '\tif query != nil {',
        '\t\tif query.Limit != nil {',
        '\t\t\tfor i := 0; i < 1; i++ {',
        '\t\t\t\tpath += "/nested-loop-stale"',
        '\t\t\t}',
        '\t\t}',
        '\t} else {',
        '\t\tpath += "/products"',
        '\t}',
        '\terr := s.client.do(ctx, "GET", path, valuesOf(query), nil, &out)',
      ].join('\n\t'),
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog\/nested-loop-stale: built by go/);
    restore();

    // Java: try/catch both terminating still evaluates calls & locals inside finally, and `Object record` param is scanned.
    restore = edit(
      'sdk/java/src/main/java/com/rmyndharis/openwa/resources/CatalogResource.java',
      'public CatalogInfo info(String sessionId) {',
      [
        'CatalogInfo finallyHelper(String sessionId, boolean throwIt) {',
        '        String p = "/api/sessions/" + encodeSegment(sessionId) + "/catalog";',
        '        try {',
        '            if (throwIt) throw new RuntimeException();',
        '            return client.request(HttpMethod.GET, p, null, null, CatalogInfo.class);',
        '        } catch (RuntimeException e) {',
        '            throw e;',
        '        } finally {',
        '            p += "/finally-stale";',
        '            client.request(HttpMethod.GET, p, null, null, CatalogInfo.class);',
        '        }',
        '    }',
        '',
        '    public void sendWithRecordParam(String sessionId, Object record) {',
        '        String r = "/api/sessions/" + encodeSegment(sessionId) + "/record-param-stale";',
        '        client.request(HttpMethod.POST, r, null, record, Object.class);',
        '    }',
        '',
        '    public CatalogInfo info(String sessionId) {',
      ].join('\n'),
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GET \/api\/sessions\/\*\/catalog\/finally-stale: built by java/);
    assert.match(result.stderr, /POST \/api\/sessions\/\*\/record-param-stale: built by java/);
    restore();
  });
});

/** Assert one exact line of the gate's report, quoting the whole report on failure. */
const reports = (result, line) => assert.ok(result.stderr.includes(`  - ${line}\n`), result.stdout + result.stderr);
const MESSAGES = 'GET /api/sessions/{sessionId}/messages';
const GAPS = 'scripts/sdk-query-parameter-gaps.json';

test('a query parameter the contract renames fails every client that still sends the old key', () => {
  // Renaming `after` to `cursor` left every client sending `after`, which the server would ignore, so a keyset
  // page walk re-read its first page forever while the path and verb checks stayed green.
  withCopy(({ edit, run }) => {
    edit('openapi.json', '"name": "after"', '"name": "cursor"');
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    for (const sdk of ['javascript', 'python', 'java', 'go']) {
      reports(result, `${MESSAGES} query "cursor": declared by the contract, sent by no ${sdk} call`);
      reports(result, `${MESSAGES} query "after": sent by ${sdk}, not declared by the contract`);
    }
    // PHP forwards its caller's array, so it sends whatever the contract names and has nothing to rename.
    assert.doesNotMatch(result.stdout + result.stderr, /sent by (?:no )?php/);
  });
});

test('a query parameter one client stops sending fails that client', () => {
  withCopy(({ edit, run }) => {
    let restore = edit('sdk/go/types_message.go', '\tsetStr(v, "after", q.After)\n', '');
    let result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    reports(result, `${MESSAGES} query "after": declared by the contract, sent by no go call`);
    restore();

    restore = edit('sdk/javascript/src/types.ts', '  after?: string;\n', '');
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    reports(result, `${MESSAGES} query "after": declared by the contract, sent by no javascript call`);
    restore();

    // A literal query map is read in both directions.
    edit('sdk/php/src/Resources/GroupsResource.php', "['code' => $code]", "['invite' => $code]");
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const joinInfo = 'GET /api/sessions/{sessionId}/groups/join-info';
    reports(result, `${joinInfo} query "code": declared by the contract, sent by no php call`);
    reports(result, `${joinInfo} query "invite": sent by php, not declared by the contract`);
  });
});

test('a PHP list method that stops forwarding its caller array fails like a dropped parameter', () => {
  withCopy(({ edit, run }) => {
    edit(
      'sdk/php/src/Resources/MessagesResource.php',
      '/messages", $query)\n            ?? [\'messages\'',
      '/messages", [])\n            ?? [\'messages\'',
    );
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    reports(result, `${MESSAGES} query "after": declared by the contract, sent by no php call`);
  });
});

// Both are correct code that sends the same keys: reading the wrapper's name found no type, and every
// parameter was reported unsent.
test('a query type behind a wrapper is read through it', () => {
  withCopy(({ edit, run }) => {
    edit(
      'sdk/python/openwa/resources/messages.py',
      'query: ListMessagesQuery | None = None) -> MessageListResponse:',
      'query: Optional[ListMessagesQuery] = None) -> MessageListResponse:',
    );
    edit(
      'sdk/javascript/src/resources/messages.ts',
      'query?: ListMessagesQuery): Promise<MessageListResponse>',
      'query?: Readonly<ListMessagesQuery>): Promise<MessageListResponse>',
    );
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test('a listed query gap that a client now sends fails until the entry is removed', () => {
  withCopy(({ edit, run }) => {
    edit(GAPS, '[]', `[{"sdk":"go","method":"GET","path":"/api/sessions/{sessionId}/messages","parameter":"after"}]`);
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    reports(result, `${MESSAGES} query "after": listed as missing from go in ${GAPS}, but it is not: remove the entry`);
  });
});
