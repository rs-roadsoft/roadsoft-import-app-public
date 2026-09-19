const test = require('node:test');
const assert = require('node:assert/strict');
const { planUpload, HASH_CHECK_STATUS } = require('../sync/plan');

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
});

test('planUpload with no entries is empty everywhere', () => {
  assert.deepEqual(planUpload([], new Map()), { toUpload: [], alreadyImported: [], rejected: [] });
});
