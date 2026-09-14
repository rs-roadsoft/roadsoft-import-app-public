/**
 * The upload journal: one row per file CONTENT, filled with the server's own
 * verdicts, consulted before every upload.
 *
 * This is the memory that stops a re-send. The filesystem move into
 * `Archived/` still happens, but it is a convenience — it fails silently on a
 * synced, locked or network folder, and on production three installations
 * re-uploaded their whole folder every hour for weeks because of that. A row
 * here survives a failed move, a restored backup and a second copy of the file
 * under another name.
 *
 * Every function takes the knex instance, so the tests run against `:memory:`
 * and the app passes its real connection.
 */
const { STATE, REASON_SOURCE, JOB_FILE_STATUS } = require('../sync/verdicts');

const JOURNAL = 'upload_journal';
const FILE_CACHE = 'file_cache';

/**
 * Rows per statement, for every multi-row INSERT and every `whereIn`.
 *
 * knex compiles a multi-row INSERT for SQLite as `SELECT … UNION ALL SELECT …`,
 * and the bundled SQLite (3.39.2 in sqlite3 5.0.11, the same library in the
 * Windows prebuild) is compiled with `MAX_COMPOUND_SELECT=500`: 500 rows insert,
 * 501 throw `too many terms in compound SELECT`. The production folder this
 * journal was written for holds 3,716 files, all new to a fresh install — the
 * first run threw before any hash-check or upload, every hour, and the tests
 * never went above twelve rows. Found in review.
 *
 * The same bound is applied to `whereIn`. The parameter cap is 32,766 here,
 * but older SQLite builds stop at 999, and a folder is allowed to be larger
 * than either.
 */
const SQLITE_CHUNK = 500;

function chunk(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) {
    result.push(array.slice(index, index + size));
  }
  return result;
}

function now() {
  return new Date().toISOString();
}

/**
 * Create both tables if they are missing. Idempotent, and called on every
 * start: the packaged app copies `app/config.db` into `userData` ONCE, so a
 * knex migration or a new template would never reach an existing install.
 *
 * `hasTable` is enough only while the shape never changes. A column added
 * later would never reach an installed machine, because the table already
 * exists there. When the schema changes, check `hasColumn` per new column and
 * `alterTable` it in, here, on the same start-up path.
 */
async function ensureSchema(db) {
  if (!(await db.schema.hasTable(JOURNAL))) {
    await db.schema.createTable(JOURNAL, (table) => {
      table.string('hash').primary();
      table.string('file_name');
      table.string('state').notNullable();
      table.string('verdict');
      table.string('reason_name');
      table.text('reason_message');
      table.string('reason_source');
      table.integer('attempts').notNullable().defaultTo(0);
      table.string('job_id');
      table.integer('import_id');
      table.string('first_seen_at').notNullable();
      table.string('last_attempt_at');
      table.string('updated_at').notNullable();
      table.index(['state']);
      table.index(['job_id']);
    });
  }
  if (!(await db.schema.hasTable(FILE_CACHE))) {
    await db.schema.createTable(FILE_CACHE, (table) => {
      table.string('path').primary();
      table.integer('size').notNullable();
      table.bigInteger('mtime_ms').notNullable();
      table.string('hash').notNullable();
    });
  }
}

async function getByHashes(db, hashes) {
  if (!hashes.length) return new Map();
  const found = new Map();
  for (const part of chunk(hashes, SQLITE_CHUNK)) {
    const rows = await db(JOURNAL).whereIn('hash', part);
    for (const row of rows) found.set(row.hash, row);
  }
  return found;
}

/**
 * Make sure a row exists for each hash. An existing row is left exactly as it
 * is — `first_seen_at`, its state and its reason all belong to history — except
 * the display name, which follows the most recent path.
 */
async function upsertPending(db, entries) {
  if (!entries.length) return;
  const known = await getByHashes(
    db,
    entries.map((entry) => entry.hash),
  );
  const stamp = now();
  const fresh = entries
    .filter((entry) => !known.has(entry.hash))
    .map((entry) => ({
      hash: entry.hash,
      file_name: entry.fileName,
      state: STATE.PENDING,
      attempts: 0,
      first_seen_at: stamp,
      updated_at: stamp,
    }));
  if (fresh.length) {
    await db.batchInsert(JOURNAL, fresh, SQLITE_CHUNK);
  }
  await Promise.all(
    entries
      .filter((entry) => known.has(entry.hash) && known.get(entry.hash).file_name !== entry.fileName)
      .map((entry) => db(JOURNAL).where({ hash: entry.hash }).update({ file_name: entry.fileName })),
  );
}

/**
 * The batch left the client: record the job and count the attempt.
 *
 * The verdict and the reason are cleared, not carried over. A row that keeps a
 * `FAILED` verdict from its previous job while this one is still in flight
 * reads as failed to the attempt cap, and was parked — with the file moved to
 * `Failed/` — while the server was importing it.
 */
async function markUploaded(db, receipts, jobId) {
  const stamp = now();
  await Promise.all(
    receipts.map((receipt) =>
      db(JOURNAL)
        .where({ hash: receipt.hash })
        .update({
          state: STATE.UPLOADED,
          verdict: null,
          reason_name: null,
          reason_message: null,
          reason_source: null,
          job_id: jobId,
          import_id: receipt.importId ?? null,
          attempts: db.raw('attempts + 1'),
          last_attempt_at: stamp,
          updated_at: stamp,
        }),
    ),
  );
}

/**
 * Write what the server said.
 *
 * Two rules keep a row from going round again, and both were missing once:
 *
 * - A terminal row never leaves its state for a non-terminal verdict.
 *   `imported` is final for everything; `parked` is final for a WAITING or a
 *   retryable-FAILED verdict. Without the second half, a poll of an OLD job —
 *   kept open by any file still WAITING in it — reported a parked file as
 *   FAILED again, moved it back to `uploaded`, and the next hash-check sent it.
 *   Eight uploads in eight runs, with the attempt cap never reached. That is
 *   the loop this journal exists to end.
 * - A job poll speaks only for the rows that job owns. Pass `jobId` and the
 *   verdict is applied only where `job_id` matches, so an old job cannot
 *   overwrite what a newer one has already said about the same bytes.
 */
async function applyVerdict(db, hash, verdict, { jobId } = {}) {
  const patch = {
    state: verdict.state,
    verdict: verdict.verdict ?? null,
    updated_at: now(),
  };
  if (verdict.reasonName !== undefined || verdict.reasonMessage !== undefined) {
    patch.reason_name = verdict.reasonName ?? null;
    patch.reason_message = verdict.reasonMessage ?? null;
    patch.reason_source = verdict.reasonSource ?? REASON_SOURCE.BACKEND;
  }
  const blocked = verdict.state === STATE.UPLOADED ? [STATE.IMPORTED, STATE.PARKED] : [STATE.IMPORTED];
  let query = db(JOURNAL).where({ hash }).whereNotIn('state', blocked);
  if (jobId) query = query.where({ job_id: jobId });
  await query.update(patch);
}

/**
 * A single file the server refuses to accept at all — too large for one
 * request. Final for those bytes, with the HTTP answer as the reason.
 */
async function parkRefusedUpload(db, hash, message) {
  await db(JOURNAL).where({ hash }).whereNotIn('state', [STATE.IMPORTED]).update({
    state: STATE.PARKED,
    verdict: null,
    reason_name: null,
    reason_message: message,
    reason_source: REASON_SOURCE.TRANSPORT,
    updated_at: now(),
  });
}

/** The request itself failed; the file was not judged. */
async function recordTransportFailure(db, hashes, message) {
  if (!hashes.length) return;
  const stamp = now();
  for (const part of chunk(hashes, SQLITE_CHUNK)) {
    await db(JOURNAL)
      .whereIn('hash', part)
      .whereNotIn('state', [STATE.IMPORTED, STATE.PARKED])
      .update({
        attempts: db.raw('attempts + 1'),
        reason_name: null,
        reason_message: message,
        reason_source: REASON_SOURCE.TRANSPORT,
        last_attempt_at: stamp,
        updated_at: stamp,
      });
  }
}

/**
 * Park every row that has used up its attempts and is not in flight.
 *
 * "Not in flight" is the half that was missing. `attempts` counts every upload,
 * successful ones included, so a third attempt that REACHED the server — job
 * WAITING, or no verdict yet — was parked in the same run, the renderer moved
 * the file to `Failed/`, the job was never polled again, and the server may well
 * have imported it. Only a row that holds a retryable FAILED verdict, or one
 * that never got as far as an upload, has actually exhausted anything.
 */
async function parkExhausted(db, maxAttempts) {
  await db(JOURNAL)
    .where('attempts', '>=', maxAttempts)
    .andWhere((query) =>
      query.where({ state: STATE.PENDING }).orWhere({ state: STATE.UPLOADED, verdict: JOB_FILE_STATUS.FAILED }),
    )
    .update({ state: STATE.PARKED, updated_at: now() });
}

/** Jobs that still have a file waiting for its verdict. */
async function listPendingJobIds(db) {
  const rows = await db(JOURNAL).distinct('job_id').where({ state: STATE.UPLOADED }).whereNotNull('job_id');
  return rows.map((row) => row.job_id);
}

async function listAll(db) {
  return db(JOURNAL).select('*').orderBy('updated_at', 'desc');
}

/** The Reset button. Both tables, so a changed file is re-hashed too. */
async function resetAll(db) {
  await db(JOURNAL).del();
  await db(FILE_CACHE).del();
}

async function fileCacheGet(db, filePath) {
  return db(FILE_CACHE).where({ path: filePath }).first();
}

async function fileCacheSet(db, entry) {
  await db(FILE_CACHE).insert(entry).onConflict('path').merge();
}

module.exports = {
  JOURNAL,
  FILE_CACHE,
  SQLITE_CHUNK,
  ensureSchema,
  getByHashes,
  upsertPending,
  markUploaded,
  applyVerdict,
  parkRefusedUpload,
  recordTransportFailure,
  parkExhausted,
  listPendingJobIds,
  listAll,
  resetAll,
  fileCacheGet,
  fileCacheSet,
};
