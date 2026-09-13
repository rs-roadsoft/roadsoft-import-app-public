const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');
const journal = require('../models/journal');
const { STATE, REASON_SOURCE, MAX_ATTEMPTS } = require('../sync/verdicts');

let db;

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await journal.ensureSchema(db);
});

afterEach(async () => {
  await db.destroy();
});

const row = (hash) => db(journal.JOURNAL).where({ hash }).first();

test('ensureSchema is idempotent — a second call on a populated database changes nothing', async () => {
  await journal.upsertPending(db, [{ hash: 'a', fileName: 'a.ddd' }]);
  await journal.ensureSchema(db);
  assert.equal((await journal.listAll(db)).length, 1);
});

test('upsertPending creates a pending row once and keeps first_seen_at on a repeat', async () => {
  await journal.upsertPending(db, [{ hash: 'a', fileName: 'a.ddd' }]);
  const first = await row('a');
  assert.equal(first.state, STATE.PENDING);
  assert.equal(first.attempts, 0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await journal.upsertPending(db, [
    { hash: 'a', fileName: 'renamed.ddd' },
    { hash: 'b', fileName: 'b.ddd' },
  ]);
  const again = await row('a');
  assert.equal(again.first_seen_at, first.first_seen_at);
  // Display name follows the latest path; nothing else moves.
  assert.equal(again.file_name, 'renamed.ddd');
  assert.equal((await journal.listAll(db)).length, 2);
});

test('markUploaded records the job, the import id and counts the attempt', async () => {
  await journal.upsertPending(db, [{ hash: 'a', fileName: 'a.ddd' }]);
  await journal.markUploaded(db, [{ hash: 'a', importId: 42 }], 'job-1');
  const after = await row('a');
  assert.equal(after.state, STATE.UPLOADED);
  assert.equal(after.job_id, 'job-1');
  assert.equal(after.import_id, 42);
  assert.equal(after.attempts, 1);
  assert.ok(after.last_attempt_at);

  await journal.markUploaded(db, [{ hash: 'a', importId: 42 }], 'job-2');
  assert.equal((await row('a')).attempts, 2);
  assert.equal((await row('a')).job_id, 'job-2');
});

test('applyVerdict writes state, verdict and the backend reason', async () => {
  await journal.upsertPending(db, [{ hash: 'a', fileName: 'a.ddd' }]);
  await journal.applyVerdict(db, 'a', {
    state: STATE.PARKED,
    verdict: 'FAILED',
    reasonName: 'file-upload/unable-to-decode',
    reasonMessage: 'Rejected at intake: file-upload/unable-to-decode',
    reasonSource: REASON_SOURCE.BACKEND,
  });
  const after = await row('a');
  assert.equal(after.state, STATE.PARKED);
  assert.equal(after.verdict, 'FAILED');
  assert.equal(after.reason_name, 'file-upload/unable-to-decode');
  assert.equal(after.reason_source, REASON_SOURCE.BACKEND);
});

test('applyVerdict never moves an imported row back — a stale poll cannot undo a success', async () => {
  await journal.upsertPending(db, [{ hash: 'a', fileName: 'a.ddd' }]);
  await journal.applyVerdict(db, 'a', { state: STATE.IMPORTED, verdict: 'DONE' });
  await journal.applyVerdict(db, 'a', { state: STATE.UPLOADED, verdict: 'WAITING' });
  await journal.applyVerdict(db, 'a', { state: STATE.PARKED, verdict: 'PERMANENTLY_FAILED' });
  assert.equal((await row('a')).state, STATE.IMPORTED);
});

test('applyVerdict without a reason leaves the stored reason untouched', async () => {
  await journal.upsertPending(db, [{ hash: 'a', fileName: 'a.ddd' }]);
  await journal.applyVerdict(db, 'a', {
    state: STATE.UPLOADED,
    verdict: 'FAILED',
    reasonName: 'max-number-of-drivers-per-vehicles',
    reasonMessage: 'Unable to add driver.',
  });
  await journal.applyVerdict(db, 'a', { state: STATE.UPLOADED, verdict: 'WAITING' });
  const after = await row('a');
  assert.equal(after.reason_name, 'max-number-of-drivers-per-vehicles');
  assert.equal(after.verdict, 'WAITING');
});

test('recordTransportFailure counts an attempt and marks the reason as transport, skipping terminal rows', async () => {
  await journal.upsertPending(db, [
    { hash: 'a', fileName: 'a.ddd' },
    { hash: 'b', fileName: 'b.ddd' },
  ]);
  await journal.applyVerdict(db, 'b', { state: STATE.IMPORTED, verdict: 'DONE' });

  await journal.recordTransportFailure(db, ['a', 'b'], 'connect ECONNREFUSED 127.0.0.1:3029');

  const a = await row('a');
  assert.equal(a.attempts, 1);
  assert.equal(a.state, STATE.PENDING);
  assert.equal(a.reason_source, REASON_SOURCE.TRANSPORT);
  assert.equal(a.reason_message, 'connect ECONNREFUSED 127.0.0.1:3029');
  assert.equal(a.reason_name, null);
  const b = await row('b');
  assert.equal(b.attempts, 0);
  assert.equal(b.state, STATE.IMPORTED);
});

test('parkExhausted parks rows at the attempt cap and leaves the rest', async () => {
  await journal.upsertPending(db, [
    { hash: 'tired', fileName: 't.ddd' },
    { hash: 'fresh', fileName: 'f.ddd' },
  ]);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await journal.recordTransportFailure(db, ['tired'], 'timeout');
  }
  await journal.recordTransportFailure(db, ['fresh'], 'timeout');

  await journal.parkExhausted(db, MAX_ATTEMPTS);

  assert.equal((await row('tired')).state, STATE.PARKED);
  assert.equal((await row('fresh')).state, STATE.PENDING);
});

test('listPendingJobIds returns only jobs that still have an uploaded row, each once', async () => {
  await journal.upsertPending(db, [
    { hash: 'a', fileName: 'a.ddd' },
    { hash: 'b', fileName: 'b.ddd' },
    { hash: 'c', fileName: 'c.ddd' },
  ]);
  await journal.markUploaded(db, [{ hash: 'a' }, { hash: 'b' }], 'job-open');
  await journal.markUploaded(db, [{ hash: 'c' }], 'job-done');
  await journal.applyVerdict(db, 'c', { state: STATE.IMPORTED, verdict: 'DONE' });

  assert.deepEqual(await journal.listPendingJobIds(db), ['job-open']);
});

test('resetAll empties the journal and the file cache', async () => {
  await journal.upsertPending(db, [{ hash: 'a', fileName: 'a.ddd' }]);
  await journal.fileCacheSet(db, { path: '/x/a.ddd', size: 10, mtime_ms: 1, hash: 'a' });

  await journal.resetAll(db);

  assert.equal((await journal.listAll(db)).length, 0);
  assert.equal(await journal.fileCacheGet(db, '/x/a.ddd'), undefined);
});

test("a folder larger than SQLite's compound-select cap goes through every multi-row statement", async () => {
  // The bundled SQLite is compiled with MAX_COMPOUND_SELECT=500 and knex writes
  // a multi-row INSERT as SELECT … UNION ALL SELECT …, so 501 rows in one
  // statement threw. The production folder has 3,716 files, all new to a fresh
  // install: the first run failed before any hash-check or upload. This crosses
  // the cap twice over on every statement that takes a list.
  const count = journal.SQLITE_CHUNK * 2 + 123;
  const entries = Array.from({ length: count }, (_, index) => ({ hash: `big-${index}`, fileName: `${index}.ddd` }));

  await journal.upsertPending(db, entries);
  assert.equal((await journal.listAll(db)).length, count);

  const found = await journal.getByHashes(
    db,
    entries.map((entry) => entry.hash),
  );
  assert.equal(found.size, count);

  await journal.recordTransportFailure(
    db,
    entries.map((entry) => entry.hash),
    'timeout',
  );
  const [{ n }] = await db(journal.JOURNAL).where({ attempts: 1 }).count({ n: '*' });
  assert.equal(Number(n), count);
});

test('fileCacheSet upserts by path', async () => {
  await journal.fileCacheSet(db, { path: '/x/a.ddd', size: 10, mtime_ms: 1, hash: 'old' });
  await journal.fileCacheSet(db, { path: '/x/a.ddd', size: 11, mtime_ms: 2, hash: 'new' });
  const cached = await journal.fileCacheGet(db, '/x/a.ddd');
  assert.equal(cached.hash, 'new');
  assert.equal(cached.size, 11);
});
