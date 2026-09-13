const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const knex = require('knex');
const journal = require('../models/journal');
const { runSync } = require('../sync/sync-folder');
const { STATE, REASON_SOURCE, MAX_ATTEMPTS } = require('../sync/verdicts');

let db;
let dir;

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await journal.ensureSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs7317-sync-'));
});

afterEach(async () => {
  await db.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');

/** Write a file and return `{ path, hash }`. */
function writeFile(name, content) {
  const bytes = Buffer.from(content);
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return { path: filePath, hash: md5(bytes) };
}

/** The real folder walk is Electron-free, so the test uses it as-is. */
const { gatherSyncFiles } = require('../sync/gather');

/**
 * A fake server with a script: what hash-check answers, what a job holds, and
 * whether uploads succeed. Every call is recorded.
 */
function fakeApi({ hashCheck = {}, jobs = {}, uploadError = null } = {}) {
  const calls = { hashCheck: [], uploadBatch: [], getJobFiles: [] };
  let jobCounter = 0;
  return {
    calls,
    jobs,
    hashCheck: async (hashes) => {
      calls.hashCheck.push(hashes);
      return new Map(hashes.map((hash) => [hash, hashCheck[hash] ?? 'NOT_IMPORTED']));
    },
    uploadBatch: async (paths) => {
      calls.uploadBatch.push(paths);
      if (uploadError) throw uploadError;
      jobCounter += 1;
      const jobId = `job-${jobCounter}`;
      const files = paths.map((filePath, index) => ({
        fileName: path.basename(filePath),
        hash: md5(fs.readFileSync(filePath)),
        importId: 1000 + index,
      }));
      // Unless the script says otherwise, the server has nothing to report yet.
      if (!jobs[jobId]) jobs[jobId] = files.map((file) => ({ hash: file.hash, status: 'WAITING', error: {} }));
      return { jobId, files };
    },
    getJobFiles: async (jobId) => {
      calls.getJobFiles.push(jobId);
      return jobs[jobId] ?? [];
    },
  };
}

const run = (api, extra = {}) => runSync({ db, api, folder: dir, gather: gatherSyncFiles, log: () => {}, ...extra });

test('first run: every new file is hash-checked once, uploaded once, and recorded with its job', async () => {
  const files = [writeFile('a.ddd', 'A'), writeFile('b.ddd', 'B'), writeFile('sub/c.esm', 'C')];
  const api = fakeApi();

  const counts = await run(api);

  assert.deepEqual(counts, { total: 3, sent: 3, skipped: 0, failed: 0 });
  assert.equal(api.calls.hashCheck.length, 1);
  assert.deepEqual(new Set(api.calls.hashCheck[0]), new Set(files.map((file) => file.hash)));
  assert.equal(api.calls.uploadBatch.length, 1);
  for (const file of files) {
    const row = await db(journal.JOURNAL).where({ hash: file.hash }).first();
    assert.equal(row.state, STATE.UPLOADED);
    assert.equal(row.job_id, 'job-1');
    assert.equal(row.attempts, 1);
  }
  // The job was polled right after the upload.
  assert.deepEqual(api.calls.getJobFiles, ['job-1']);
});

test('the production shape: every file already refused, two copies each — hash-check once, bulk NEVER', async () => {
  const hashCheck = {};
  for (let index = 0; index < 12; index += 1) {
    const original = writeFile(`file-${index}.ddd`, `content ${index}`);
    writeFile(`restored/file-${index}.ddd`, `content ${index}`);
    hashCheck[original.hash] = 'PERMANENTLY_FAILED';
  }
  const api = fakeApi({ hashCheck });
  const statuses = new Map();

  const counts = await run(api, { onFileStatus: (filePath, status) => statuses.set(filePath, status) });

  assert.equal(api.calls.uploadBatch.length, 0);
  assert.equal(api.calls.hashCheck.length, 1);
  assert.equal(api.calls.hashCheck[0].length, 12, 'twelve hashes for twenty-four paths');
  assert.deepEqual(counts, { total: 12, sent: 0, skipped: 12, failed: 0 });
  // Every path on disk, including the copies, is told what happened.
  assert.equal(statuses.size, 24);
  assert.ok([...statuses.values()].every((status) => status.status === 'Not Synced'));
  assert.ok([...statuses.values()].every((status) => status.label.startsWith('Parked')));
});

test('second run: files the server already imported are skipped, and never uploaded again', async () => {
  const file = writeFile('a.ddd', 'A');
  const api = fakeApi({ hashCheck: { [file.hash]: 'ALREADY_IMPORTED' } });

  await run(api);
  await run(api);

  assert.equal(api.calls.uploadBatch.length, 0);
  // Terminal after the first run, so the second run does not even ask.
  assert.equal(api.calls.hashCheck.length, 1);
  assert.equal((await db(journal.JOURNAL).where({ hash: file.hash }).first()).state, STATE.IMPORTED);
});

test('a verdict that arrives after upload parks the file with the backend reason, and it is not sent again', async () => {
  const good = writeFile('good.ddd', 'good');
  const bad = writeFile('bad.ddd', 'bad');
  const api = fakeApi();
  // The server refuses `bad` at intake: the job carries the reason at once.
  api.uploadBatch = ((original) => async (paths) => {
    const receipt = await original(paths);
    api.jobs[receipt.jobId] = [
      { hash: good.hash, status: 'WAITING', error: {} },
      {
        hash: bad.hash,
        status: 'FAILED',
        error: {
          name: 'file-upload/not-a-tachograph-file',
          message: 'Rejected at intake: file-upload/not-a-tachograph-file',
        },
      },
    ];
    return receipt;
  })(api.uploadBatch);

  await run(api);

  const badRow = await db(journal.JOURNAL).where({ hash: bad.hash }).first();
  assert.equal(badRow.state, STATE.PARKED);
  assert.equal(badRow.reason_name, 'file-upload/not-a-tachograph-file');
  assert.equal(badRow.reason_message, 'Rejected at intake: file-upload/not-a-tachograph-file');
  assert.equal(badRow.reason_source, REASON_SOURCE.BACKEND);
  assert.equal((await db(journal.JOURNAL).where({ hash: good.hash }).first()).state, STATE.UPLOADED);

  // Next run: the job is polled FIRST and now says `good` is done. Both files
  // are terminal before the folder is even scanned, so nothing is uploaded and
  // hash-check is not asked a second time.
  api.jobs['job-1'][0] = { hash: good.hash, status: 'DONE', error: {} };
  await run(api);

  assert.equal(api.calls.uploadBatch.length, 1, 'no second upload');
  assert.equal(api.calls.hashCheck.length, 1, 'nothing open to ask about');
  assert.equal((await db(journal.JOURNAL).where({ hash: good.hash }).first()).state, STATE.IMPORTED);
});

test('open jobs are settled at the START of the next run, before anything is sent', async () => {
  const file = writeFile('a.ddd', 'A');
  const api = fakeApi();
  await run(api);
  // The decode finished between runs and the importer refused the file.
  api.jobs['job-1'] = [
    {
      hash: file.hash,
      status: 'FAILED',
      error: { name: 'file-upload/upload-not-allowed/already-exists', message: 'already exists' },
    },
  ];

  await run(api);

  assert.equal(api.calls.uploadBatch.length, 1);
  const row = await db(journal.JOURNAL).where({ hash: file.hash }).first();
  assert.equal(row.state, STATE.PARKED);
  assert.equal(row.reason_name, 'file-upload/upload-not-allowed/already-exists');
});

test('a transport failure is counted per file and parks after MAX_ATTEMPTS runs', async () => {
  const file = writeFile('a.ddd', 'A');
  const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3029'), { code: 'ECONNREFUSED' });
  const api = fakeApi({ uploadError: error });

  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const counts = await run(api);
    assert.equal(counts.failed, 1);
    const row = await db(journal.JOURNAL).where({ hash: file.hash }).first();
    assert.equal(row.state, STATE.PENDING, `still pending after attempt ${attempt}`);
    assert.equal(row.attempts, attempt);
    assert.equal(row.reason_source, REASON_SOURCE.TRANSPORT);
  }

  await run(api);
  const parked = await db(journal.JOURNAL).where({ hash: file.hash }).first();
  assert.equal(parked.state, STATE.PARKED);
  assert.equal(parked.attempts, MAX_ATTEMPTS);
  assert.equal(parked.reason_message, 'connect ECONNREFUSED 127.0.0.1:3029');

  // Parked: the next run neither asks nor sends.
  const before = api.calls.uploadBatch.length;
  await run(api);
  assert.equal(api.calls.uploadBatch.length, before);
});

test('two copies of one file on disk are one upload, and both paths get the status', async () => {
  const original = writeFile('card.ddd', 'same bytes');
  const copy = writeFile('backup/card (1).ddd', 'same bytes');
  const api = fakeApi();
  const statuses = new Map();

  await run(api, { onFileStatus: (filePath, status) => statuses.set(filePath, status) });

  assert.equal(api.calls.uploadBatch.length, 1);
  assert.equal(api.calls.uploadBatch[0].length, 1, 'one path sent for two on disk');
  assert.equal(statuses.get(original.path).status, 'Synced');
  assert.equal(statuses.get(copy.path).status, 'Synced');
  assert.equal((await journal.listAll(db)).length, 1);
});

test('a second trigger while a run is in flight is refused rather than doubled', async () => {
  writeFile('a.ddd', 'A');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const api = fakeApi();
  const slowApi = { ...api, hashCheck: async (hashes) => gate.then(() => api.hashCheck(hashes)) };

  const first = run(slowApi);
  const second = await run(slowApi);
  release();
  const firstResult = await first;

  assert.deepEqual(second, { skipped: true });
  assert.equal(firstResult.sent, 1);
  assert.equal(api.calls.uploadBatch.length, 1);
});

test('a server that cannot be asked postpones the run and counts nothing against any file', async () => {
  // Distinct from a failed upload. A failed upload is a fact about one batch;
  // an unreachable server is a fact about the network, and three hours of it
  // must not park a folder of perfectly good files.
  const file = writeFile('a.ddd', 'A');
  const api = fakeApi();
  api.hashCheck = async () => {
    throw Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:1'), { code: 'ETIMEDOUT' });
  };

  const counts = await run(api);

  assert.equal(counts.unreachable, true);
  assert.equal(api.calls.uploadBatch.length, 0);
  const row = await db(journal.JOURNAL).where({ hash: file.hash }).first();
  assert.equal(row.state, STATE.PENDING);
  assert.equal(row.attempts, 0, 'no attempt was charged');
  assert.equal(row.reason_source, null);
});

test('an empty folder is a no-op that still settles open jobs', async () => {
  const api = fakeApi();
  const counts = await run(api);
  assert.deepEqual(counts, { total: 0, sent: 0, skipped: 0, failed: 0 });
  assert.equal(api.calls.hashCheck.length, 0);
});
