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
      // A fixed error, or a script: `(paths, callIndex) => error | null`.
      const error = typeof uploadError === 'function' ? uploadError(paths, calls.uploadBatch.length) : uploadError;
      if (error) throw error;
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

test('a request the server answered with an error is counted per file and parks after MAX_ATTEMPTS runs', async () => {
  // An HTTP error IS an answer — the batch reached the server and was refused —
  // so it is charged. A request that got no answer at all is the other case,
  // tested below: charged to nothing.
  const file = writeFile('a.ddd', 'A');
  const error = Object.assign(new Error('Request failed with status code 500'), {
    response: { status: 500, data: { message: 'Internal server error' } },
  });
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
  assert.equal(parked.reason_message, 'HTTP 500 Internal server error');

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
  // Uploaded and waiting: both copies stay in place until the verdict arrives.
  assert.equal(statuses.get(original.path).status, 'Pending');
  assert.equal(statuses.get(copy.path).status, 'Pending');
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

  assert.deepEqual(second, { refused: true });
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

test("a file the server already holds from THIS client's own upload stays open until its job answers", async () => {
  // hash-check answers ALREADY_IMPORTED for a staged or in-flight row too. For
  // a row this client uploaded and is waiting on, that means "do not send
  // again" and nothing more — the job poll owns the outcome. Treating it as
  // final stopped the poll and hid a later retryable failure behind "Imported".
  const file = writeFile('a.ddd', 'A');
  const answers = {}; // read at call time, so the answer can change between runs
  const api = fakeApi({ hashCheck: answers });
  await run(api); // NOT_IMPORTED -> uploaded, job-1, still WAITING

  answers[file.hash] = 'ALREADY_IMPORTED';
  await run(api); // hash-check now says ALREADY_IMPORTED for the in-flight row

  const row = await db(journal.JOURNAL).where({ hash: file.hash }).first();
  assert.equal(row.state, STATE.UPLOADED, 'not marked imported on hash-check alone');
  assert.deepEqual(await journal.listPendingJobIds(db), ['job-1'], 'the job is still polled');
  assert.equal(api.calls.uploadBatch.length, 1, 'and it was not re-sent');

  // The job finally answers: THAT is what settles it.
  api.jobs['job-1'][0] = { hash: file.hash, status: 'DONE', error: {} };
  await run(api);
  assert.equal((await db(journal.JOURNAL).where({ hash: file.hash }).first()).state, STATE.IMPORTED);
});

test('statuses: only settled files are told to move — imported to Archived, parked to Failed, the rest stay', async () => {
  // Reporting a pending row as 'Not Synced' sent it to Failed/, which the next
  // scan skips: one failed attempt was final and the retry never had a file.
  const parked = writeFile('parked.ddd', 'P');
  const imported = writeFile('imported.ddd', 'I');
  const waiting = writeFile('waiting.ddd', 'W');
  const api = fakeApi({ hashCheck: { [parked.hash]: 'PERMANENTLY_FAILED', [imported.hash]: 'ALREADY_IMPORTED' } });
  const statuses = new Map();

  await run(api, { onFileStatus: (filePath, status) => statuses.set(filePath, status.status) });

  assert.equal(statuses.get(parked.path), 'Not Synced', 'parked -> Failed/');
  assert.equal(statuses.get(imported.path), 'Synced', 'imported -> Archived/');
  assert.equal(statuses.get(waiting.path), 'Pending', 'uploaded, waiting -> stays');
});

test('a file that cannot be read is skipped for this run and does not abort the others', async () => {
  const good = writeFile('good.ddd', 'G');
  const ghost = path.join(dir, 'ghost.ddd');
  const api = fakeApi();
  const skipped = [];
  const gatherWithGhost = () => [...gatherSyncFiles(dir), ghost];

  const counts = await runSync({
    db,
    api,
    folder: dir,
    gather: gatherWithGhost,
    log: (message) => skipped.push(message),
  });

  assert.equal(counts.sent, 1);
  assert.equal(api.calls.uploadBatch[0].length, 1);
  assert.equal(api.calls.uploadBatch[0][0], good.path);
  assert.ok(skipped.some((message) => message.includes('ghost.ddd') && message.includes('ENOENT')));
});

test("a folder larger than SQLite's compound-select cap syncs in one run", async () => {
  // Every list-taking statement crosses the 500-row cap. Small files, so the
  // hashing is cheap; the point is the journal's statements, not the bytes.
  const count = journal.SQLITE_CHUNK * 2 + 77;
  for (let index = 0; index < count; index += 1) writeFile(`big/${index}.ddd`, `content ${index}`);
  const api = fakeApi();

  const counts = await run(api);

  assert.equal(counts.total, count);
  assert.equal(counts.sent, count);
  assert.equal(api.calls.uploadBatch.length, Math.ceil(count / 100));
  assert.equal((await journal.listAll(db)).length, count);
});

test('an empty folder is a no-op that still settles open jobs', async () => {
  const api = fakeApi();
  const counts = await run(api);
  assert.deepEqual(counts, { total: 0, sent: 0, skipped: 0, failed: 0 });
  assert.equal(api.calls.hashCheck.length, 0);
});

// --- Errors the fake server answers with, in the shapes axios produces. ---
const transportError = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const httpError = (status, message = `Request failed with status code ${status}`) =>
  Object.assign(new Error(message), { response: { status, data: { message } } });
const retryableFailure = (hash) => ({
  hash,
  status: 'FAILED',
  error: { name: 'max-number-of-drivers-per-vehicles', message: 'Maximum number of drivers reached' },
});
const rowOf = (hash) => db(journal.JOURNAL).where({ hash }).first();

test('a poll of an old job cannot un-park a file, so MAX_ATTEMPTS holds and the re-upload loop ends', async () => {
  // The production shape that defeated the first version: one file the server
  // never settles keeps its job open for ever, and a sibling in the same job
  // keeps failing with a RETRYABLE code. Every hourly poll of that old job
  // reported the sibling FAILED again — which moved a parked row back to
  // uploaded, and the next hash-check sent it. Eight uploads in eight runs.
  const waiting = writeFile('waiting.ddd', 'W');
  const flaky = writeFile('flaky.ddd', 'F');
  const hashCheck = {};
  const api = fakeApi({ hashCheck });
  const scriptedGetJobFiles = api.getJobFiles;
  api.getJobFiles = async (jobId) =>
    (await scriptedGetJobFiles(jobId)).map((file) => (file.hash === flaky.hash ? retryableFailure(file.hash) : file));

  // Run 1 uploads both under job-1. From then on the server holds `waiting`
  // staged, and answers ALREADY_IMPORTED for it — which is what keeps job-1
  // open and polled on every later run.
  await run(api);
  hashCheck[waiting.hash] = 'ALREADY_IMPORTED';
  for (let pass = 1; pass < 8; pass += 1) await run(api);

  const row = await rowOf(flaky.hash);
  assert.equal(row.state, STATE.PARKED);
  assert.equal(row.attempts, MAX_ATTEMPTS);
  const flakyUploads = api.calls.uploadBatch.filter((paths) => paths.includes(flaky.path)).length;
  assert.equal(flakyUploads, MAX_ATTEMPTS, 'uploaded exactly MAX_ATTEMPTS times, then never again');
  // ...while the file that is genuinely waiting is neither parked nor re-sent.
  const waitingRow = await rowOf(waiting.hash);
  assert.equal(waitingRow.state, STATE.UPLOADED);
  assert.equal(api.calls.uploadBatch.filter((paths) => paths.includes(waiting.path)).length, 1);
});

test('the attempt cap never parks an upload that reached the server', async () => {
  // Attempts count every upload, successful ones included. Two answered
  // failures and then a success is three attempts — and the third one is a
  // job the server is working on. Parking it moved the file to Failed/ while
  // the server imported it.
  const file = writeFile('third-time.ddd', 'T');
  const statuses = [];
  const api = fakeApi({ uploadError: (paths, callIndex) => (callIndex <= 2 ? httpError(500) : null) });

  await run(api, { onFileStatus: (_, { status }) => statuses.push(status) });
  await run(api, { onFileStatus: (_, { status }) => statuses.push(status) });
  await run(api, { onFileStatus: (_, { status }) => statuses.push(status) });

  const row = await rowOf(file.hash);
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.state, STATE.UPLOADED);
  assert.equal(row.verdict, 'WAITING');
  assert.equal(statuses.at(-1), 'Pending', 'not reported as Not Synced, so the renderer leaves the file in place');
  assert.equal(api.calls.uploadBatch.length, 3);
});

test('a network drop during upload charges nothing and postpones the remaining batches', async () => {
  // 101 files: two batches. The first never reaches the server. The hash-check
  // path already treated an unreachable server as "no verdict on anything";
  // the upload path charged every file behind the drop, and three such runs
  // parked a whole folder.
  const files = Array.from({ length: 101 }, (_, index) =>
    writeFile(`f${String(index).padStart(3, '0')}.ddd`, `F${index}`),
  );
  const api = fakeApi({ uploadError: () => transportError() });

  const counts = await run(api);

  assert.equal(counts.unreachable, true);
  assert.equal(api.calls.uploadBatch.length, 1, 'the second batch is not attempted');
  const rows = await db(journal.JOURNAL).select('state', 'attempts');
  assert.equal(rows.length, files.length);
  assert.ok(
    rows.every((row) => row.state === STATE.PENDING && row.attempts === 0),
    'no file is charged',
  );
});

test('a file whose own job failed retryably is settled by a later ALREADY_IMPORTED', async () => {
  // The server holds a good copy of these bytes from elsewhere. That used to
  // be ignored for ever because the row "belonged to its job" — which had
  // already answered. Polled every run, never settled.
  const file = writeFile('elsewhere.ddd', 'E');
  const hashCheck = {};
  const api = fakeApi({ hashCheck });
  const scriptedGetJobFiles = api.getJobFiles;
  api.getJobFiles = async (jobId) => (await scriptedGetJobFiles(jobId)).map((one) => retryableFailure(one.hash));

  await run(api);
  assert.equal((await rowOf(file.hash)).state, STATE.UPLOADED);

  hashCheck[file.hash] = 'ALREADY_IMPORTED';
  await run(api);

  const row = await rowOf(file.hash);
  assert.equal(row.state, STATE.IMPORTED);
  assert.equal(api.calls.uploadBatch.length, 1, 'not sent again');
});

test('a batch refused for its size is re-sent one file at a time, and only the oversized file is parked', async () => {
  const good = writeFile('good.ddd', 'G');
  const big = writeFile('big.ddd', 'B');
  const other = writeFile('other.ddd', 'O');
  const api = fakeApi({
    uploadError: (paths) => (paths.length > 1 || paths[0] === big.path ? httpError(413, 'Payload too large') : null),
  });

  await run(api);

  assert.equal((await rowOf(big.hash)).state, STATE.PARKED);
  assert.match((await rowOf(big.hash)).reason_message, /HTTP 413/);
  assert.equal((await rowOf(good.hash)).state, STATE.UPLOADED);
  assert.equal((await rowOf(other.hash)).state, STATE.UPLOADED);
  // One refused batch, then one request per file.
  assert.equal(api.calls.uploadBatch.length, 4);
});

test('a file larger than the server accepts is parked locally and never sent', async () => {
  const { MAX_UPLOAD_FILE_BYTES } = require('../sync/api');
  const huge = writeFile('huge.ddd', Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1, 1));
  const small = writeFile('small.ddd', 'S');
  const api = fakeApi();

  await run(api);

  const row = await rowOf(huge.hash);
  assert.equal(row.state, STATE.PARKED);
  assert.match(row.reason_message, /server accepts at most 7 MiB/);
  assert.ok(
    api.calls.uploadBatch.every((paths) => !paths.includes(huge.path)),
    'never uploaded',
  );
  assert.equal((await rowOf(small.hash)).state, STATE.UPLOADED);
});
