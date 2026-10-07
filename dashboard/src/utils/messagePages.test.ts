import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbRowsFetched, nextMessagePageParam, upsertIntoPages, type MessagePage } from './messagePages.ts';
import { MEDIA_PAYLOAD_CACHE_LIMIT, mergeChatMessages, type ChatMessageView } from './chatMessages.ts';

const PAGE_SIZE = 100;

const msg = (id: string, extra: Partial<ChatMessageView> = {}): ChatMessageView =>
  ({
    id,
    waMessageId: id,
    chatId: 'c1',
    body: id,
    type: 'text',
    direction: 'incoming',
    status: 'read',
    timestamp: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }) as ChatMessageView;

/** `fetched` defaults to a full page, i.e. "the server had at least this many more". */
const page = (db: ChatMessageView[], fetched = PAGE_SIZE, history: ChatMessageView[] = []): MessagePage => ({
  db,
  history,
  fetched,
});

const rows = (count: number, prefix: string): ChatMessageView[] =>
  Array.from({ length: count }, (_, i) => msg(`${prefix}${i}`));

const mediaMsg = (id: string, data: string): ChatMessageView =>
  msg(id, { type: 'image', metadata: { media: { mimetype: 'image/jpeg', filename: `${id}.jpg`, data } } });

test('a delayed live echo cannot restore a revoked history-only message', () => {
  const pages = [page([], 0, [msg('old', { type: 'revoked', body: '' })])];
  const result = upsertIntoPages(
    pages,
    msg('old', {
      type: 'poll',
      metadata: { poll: { name: 'Q', options: ['A'], allowMultipleAnswers: false } },
    }),
  );
  const [merged] = mergeChatMessages(
    result.flatMap(p => p.db),
    result.flatMap(p => p.history),
  );
  assert.equal(merged.type, 'revoked');
  assert.equal(merged.body, '');
  assert.equal(merged.metadata, undefined);
});

test('the cursor counts DB rows, not the rendered merge', () => {
  // The regression this guards: engine history inflates the rendered list, so paging by its length
  // would ask for an offset past rows the DB read never returned — silently skipping them.
  const pages = [page([msg('a'), msg('b')], PAGE_SIZE, [msg('h1'), msg('h2'), msg('h3')])];

  assert.equal(dbRowsFetched(pages), 2);
  assert.equal(nextMessagePageParam(pages, PAGE_SIZE), 2);
});

test('the cursor accumulates across pages', () => {
  const pages = [page([msg('a'), msg('b')]), page([msg('c')])];

  assert.equal(nextMessagePageParam(pages, PAGE_SIZE), 3);
});

test('paging stops once a page comes back short of what it asked for', () => {
  assert.equal(nextMessagePageParam([page([msg('a'), msg('b')], 2)], PAGE_SIZE), undefined);
});

test('paging stops on an empty chat rather than asking for offset 0 forever', () => {
  assert.equal(nextMessagePageParam([page([], 0)], PAGE_SIZE), undefined);
});

test('live messages move the cursor without ending the paging', () => {
  // The bug this locks out: terminating on "rows held >= the chat's row total" compares a count
  // that grows (every live arrival is merged into page 0) against a total frozen at the last
  // fetch. On a 105-row chat the two met after five live messages and the five oldest rows became
  // unreachable until a reload. The offset SHOULD follow the arrivals — each server insert shifts
  // the window by one — so only the stopping rule changes.
  let pages = [page(rows(PAGE_SIZE, 'db-'), PAGE_SIZE)];
  assert.equal(nextMessagePageParam(pages, PAGE_SIZE), 100);

  for (let i = 0; i < 5; i++) pages = upsertIntoPages(pages, msg(`live-${i}`));

  assert.equal(nextMessagePageParam(pages, PAGE_SIZE), 105);
});

test('a failed send does not shift the cursor past a real row', () => {
  // ChatComposer's tempId is `temp_${Date.now()}`; a failed one stays in page.db with
  // status: 'failed' forever (nothing removes it). Counting it as a fetched row offsets every
  // later page by one and permanently strands whichever real row that offset skips.
  const pages = [page([...rows(PAGE_SIZE, 'db-'), msg('temp_1700000000000', { status: 'failed' })], PAGE_SIZE)];

  assert.equal(dbRowsFetched(pages), PAGE_SIZE);
  assert.equal(nextMessagePageParam(pages, PAGE_SIZE), PAGE_SIZE);
});

test('a genuine DB row with no waMessageId still counts', () => {
  // The exclusion is matched on the id PREFIX, not on a missing waMessageId — that field is
  // nullable on a real persisted row too, so using its absence as the signal would double-count.
  const pages = [page([msg('db-1', { waMessageId: undefined })])];

  assert.equal(dbRowsFetched(pages), 1);
});

test('a media-heavy page 0 stays under the payload ceiling as live messages land', () => {
  // page.db is stored ascending (reversed from the server's createdAt DESC at fetch time), so the
  // cap that mergeOrAppend runs through upsertIntoPages strips the OLDEST payload of the page, not
  // the newest -- the opposite of what stripping from the front would do on server order.
  const full = [page(Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT }, (_, i) => mediaMsg(`m-${i}`, `P${i}`)))];

  const result = upsertIntoPages(full, mediaMsg('m-new', 'NEW'));

  const withPayload = result[0].db.filter(m => m.metadata?.media?.data);
  assert.equal(withPayload.length, MEDIA_PAYLOAD_CACHE_LIMIT);
  assert.equal(result[0].db[0].metadata?.media?.data, undefined); // oldest stripped
  assert.equal(result[0].db[0].metadata?.media?.omitted, true);
  assert.equal(result[0].db[result[0].db.length - 1].metadata?.media?.data, 'NEW'); // newest kept
});

test('a live message lands on the newest page', () => {
  const pages = [page([msg('new')]), page([msg('old')])];

  const result = upsertIntoPages(pages, msg('live'));

  assert.deepEqual(
    result[0].db.map(m => m.id),
    ['new', 'live'],
  );
  assert.deepEqual(
    result[1].db.map(m => m.id),
    ['old'],
  );
});

test('a message already held by an older page is merged there, not duplicated', () => {
  // mergeOrAppend appends when it finds no match, so running it over every page would leave one
  // copy per page. An ack for an old message must update it where it lives.
  const pages = [page([msg('new')]), page([msg('old', { status: 'sent' })])];

  const result = upsertIntoPages(pages, msg('old', { status: 'read' }));

  assert.equal(result.flatMap(p => p.db).filter(m => m.id === 'old').length, 1);
  assert.equal(result[0].db.length, 1);
  assert.equal(result[1].db[0].status, 'read');
});

test('an optimistic placeholder is dropped from whichever page holds it', () => {
  const pages = [page([msg('tmp-1')])];

  const result = upsertIntoPages(pages, msg('real-1'), 'tmp-1');

  assert.deepEqual(
    result.flatMap(p => p.db).map(m => m.id),
    ['real-1'],
  );
});

test('the placeholder is dropped even when the echo already arrived on its own', () => {
  // The send response and the realtime echo race: if the echo won, the placeholder must still go,
  // and its payload must fold into the echo rather than leaving two bubbles.
  const pages = [page([msg('tmp-1'), msg('real-1')])];

  const result = upsertIntoPages(pages, msg('real-1', { status: 'sent' }), 'tmp-1');

  assert.deepEqual(
    result.flatMap(p => p.db).map(m => m.id),
    ['real-1'],
  );
});
