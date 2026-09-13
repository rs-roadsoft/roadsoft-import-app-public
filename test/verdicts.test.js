const { test } = require('node:test');
const assert = require('node:assert/strict');
const verdicts = require('../sync/verdicts');

const { STATE, HASH_CHECK_STATUS, JOB_FILE_STATUS, REASON_SOURCE } = verdicts;

test('hash-check: ALREADY_IMPORTED and PERMANENTLY_FAILED are terminal, NOT_IMPORTED means upload', () => {
  assert.deepEqual(verdicts.fromHashCheck(HASH_CHECK_STATUS.ALREADY_IMPORTED), {
    state: STATE.IMPORTED,
    verdict: 'ALREADY_IMPORTED',
  });
  assert.deepEqual(verdicts.fromHashCheck(HASH_CHECK_STATUS.PERMANENTLY_FAILED), {
    state: STATE.PARKED,
    verdict: 'PERMANENTLY_FAILED',
  });
  assert.equal(verdicts.fromHashCheck(HASH_CHECK_STATUS.NOT_IMPORTED), null);
  // An unknown status is treated as "upload" rather than as a skip: skipping on
  // a value we do not understand would silently stop a file for ever.
  assert.equal(verdicts.fromHashCheck('SOMETHING_NEW'), null);
  assert.equal(verdicts.fromHashCheck(undefined), null);
});

test('job poll: DONE is imported, and the backend reason is carried along', () => {
  assert.deepEqual(verdicts.fromJobFile({ status: JOB_FILE_STATUS.DONE, error: {} }), {
    state: STATE.IMPORTED,
    verdict: 'DONE',
  });
});

test('job poll: FAILED with a permanent code parks, with the backend reason verbatim', () => {
  const file = {
    status: JOB_FILE_STATUS.FAILED,
    error: { name: 'file-upload/upload-not-allowed/already-exists', message: 'Rejected at intake: ...' },
  };
  assert.deepEqual(verdicts.fromJobFile(file), {
    state: STATE.PARKED,
    verdict: 'FAILED',
    reasonName: 'file-upload/upload-not-allowed/already-exists',
    reasonMessage: 'Rejected at intake: ...',
    reasonSource: REASON_SOURCE.BACKEND,
  });
});

test('job poll: FAILED with a non-permanent code stays uploaded and keeps the reason for the retry counter', () => {
  const file = {
    status: JOB_FILE_STATUS.FAILED,
    error: { name: 'max-number-of-drivers-per-vehicles', message: 'Unable to add driver.' },
  };
  const result = verdicts.fromJobFile(file);
  assert.equal(result.state, STATE.UPLOADED);
  assert.equal(result.reasonName, 'max-number-of-drivers-per-vehicles');
  assert.equal(result.reasonSource, REASON_SOURCE.BACKEND);
});

test('job poll: WAITING, a missing status and an empty error object leave the row uploaded with no reason', () => {
  for (const file of [{ status: JOB_FILE_STATUS.WAITING, error: {} }, { status: undefined }, {}]) {
    const result = verdicts.fromJobFile(file);
    assert.equal(result.state, STATE.UPLOADED);
    assert.equal(result.verdict, 'WAITING');
    assert.equal('reasonName' in result, false);
  }
});

test('every permanent code the backend lists is recognised, and nothing else is', () => {
  for (const code of [
    'file-upload/upload-not-allowed/already-exists',
    'file-upload/file-for-period-already-processed',
    'file-upload/unable-to-decode',
    'file-upload/not-a-tachograph-file',
  ]) {
    assert.equal(verdicts.isPermanentCode(code), true, code);
  }
  // Refused today, but a property of the plan or the age window rather than of
  // the bytes — the server itself does not list them as permanent.
  assert.equal(verdicts.isPermanentCode('file-upload/upload-not-allowed/too-old'), false);
  assert.equal(verdicts.isPermanentCode('max-number-of-drivers-per-vehicles'), false);
  assert.equal(verdicts.isPermanentCode(undefined), false);
  assert.equal(verdicts.isPermanentCode(null), false);
});

test('isTerminal: imported and parked are never sent again', () => {
  assert.equal(verdicts.isTerminal({ state: STATE.IMPORTED }), true);
  assert.equal(verdicts.isTerminal({ state: STATE.PARKED }), true);
  assert.equal(verdicts.isTerminal({ state: STATE.UPLOADED }), false);
  assert.equal(verdicts.isTerminal({ state: STATE.PENDING }), false);
});

test('describe: the table text names the state and shows the backend reason when there is one', () => {
  assert.equal(verdicts.describe({ state: STATE.IMPORTED }), 'Imported');
  assert.equal(
    verdicts.describe({
      state: STATE.PARKED,
      reason_name: 'file-upload/not-a-tachograph-file',
      reason_message: 'Rejected at intake: file-upload/not-a-tachograph-file',
    }),
    'Parked — file-upload/not-a-tachograph-file: Rejected at intake: file-upload/not-a-tachograph-file',
  );
  assert.equal(
    verdicts.describe({ state: STATE.PARKED, verdict: 'PERMANENTLY_FAILED' }),
    'Parked — PERMANENTLY_FAILED',
  );
  assert.equal(verdicts.describe({ state: STATE.UPLOADED }), 'Uploaded — waiting for verdict');
  assert.equal(
    verdicts.describe({ state: STATE.PENDING, reason_message: 'connect ECONNREFUSED', attempts: 2 }),
    'Not synced — connect ECONNREFUSED (attempt 2)',
  );
});
