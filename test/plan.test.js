const test = require('node:test');
const assert = require('node:assert/strict');
const { planUpload, batchForUpload, HASH_CHECK_STATUS } = require('../sync/plan');

const entry = (hash) => ({ hash, fileName: `${hash}.ddd`, paths: [`/root/${hash}.ddd`] });

test('planUpload sorts entries by the server answer, and uploads what the server does not know', () => {
  const entries = [entry('imported'), entry('rejected'), entry('new'), entry('unanswered')];
  const answers = new Map([
    ['imported', HASH_CHECK_STATUS.ALREADY_IMPORTED],
    ['rejected', HASH_CHECK_STATUS.PERMANENTLY_FAILED],
    ['new', HASH_CHECK_STATUS.NOT_IMPORTED],
  ]);

  const plan = planUpload(entries, answers);

  assert.deepEqual(
    plan.alreadyImported.map((one) => one.hash),
    ['imported'],
  );
  assert.deepEqual(
    plan.rejected.map((one) => one.hash),
    ['rejected'],
  );
  assert.deepEqual(
    plan.toUpload.map((one) => one.hash),
    ['new', 'unanswered'],
  );
  assert.deepEqual(plan.unknown, []);
});

test('planUpload never uploads on a status it does not know — a future server state must not become a storm', () => {
  const plan = planUpload(
    [entry('a'), entry('b')],
    new Map([
      ['a', 'QUARANTINED'],
      ['b', 'NOT_IMPORTED'],
    ]),
  );

  assert.deepEqual(
    plan.toUpload.map((one) => one.hash),
    ['b'],
  );
  assert.equal(plan.unknown.length, 1);
  assert.equal(plan.unknown[0].hash, 'a');
  assert.equal(plan.unknown[0].status, 'QUARANTINED');
});

test('planUpload with no entries is empty everywhere', () => {
  assert.deepEqual(planUpload([], new Map()), { toUpload: [], alreadyImported: [], rejected: [], unknown: [] });
});

test('batchForUpload cuts by file count and by bytes, whichever comes first', () => {
  const small = (hash) => ({ hash, size: 10, paths: [hash] });
  const big = (hash) => ({ hash, size: 60, paths: [hash] });

  // count: 5 small files, max 2 per batch -> 2 + 2 + 1
  assert.deepEqual(
    batchForUpload([small('a'), small('b'), small('c'), small('d'), small('e')], { maxFiles: 2, maxBytes: 1000 }).map(
      (batch) => batch.length,
    ),
    [2, 2, 1],
  );

  // bytes: 60 + 60 > 100 -> each big file alone; small ones share a batch
  assert.deepEqual(
    batchForUpload([big('a'), big('b'), small('c'), small('d')], { maxFiles: 100, maxBytes: 100 }).map((batch) =>
      batch.map((entry) => entry.hash),
    ),
    [['a'], ['b', 'c', 'd']],
  );

  // an entry over maxBytes on its own still gets a batch, never dropped
  assert.deepEqual(
    batchForUpload([{ hash: 'x', size: 500, paths: ['x'] }], { maxFiles: 100, maxBytes: 100 }).map(
      (batch) => batch.length,
    ),
    [1],
  );

  assert.deepEqual(batchForUpload([], { maxFiles: 100, maxBytes: 100 }), []);
});
