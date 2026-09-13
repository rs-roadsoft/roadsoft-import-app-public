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
const { STATE, REASON_SOURCE } = require('../sync/verdicts');

const JOURNAL = 'upload_journal';
const FILE_CACHE = 'file_cache';

function now() {
  return new Date().toISOString();
}

/**
 * Create both tables if they are missing. Idempotent, and called on every
 * start: the packaged app copies `app/config.db` into `userData` ONCE, so a
 * knex migration or a new template would never reach an existing install.
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
  const rows = await db(JOURNAL).whereIn('hash', hashes);
  return new Map(rows.map((row) => [row.hash, row]));
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
    await db(JOURNAL).insert(fresh);
  }
  await Promise.all(
    entries
      .filter((entry) => known.has(entry.hash) && known.get(entry.hash).file_name !== entry.fileName)
      .map((entry) => db(JOURNAL).where({ hash: entry.hash }).update({ file_name: entry.fileName })),
  );
}

/** The batch left the client: record the job and count the attempt. */
async function markUploaded(db, receipts, jobId) {
  const stamp = now();
  await Promise.all(
    receipts.map((receipt) =>
      db(JOURNAL)
        .where({ hash: receipt.hash })
        .update({
          state: STATE.UPLOADED,
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
 * Write what the server said. `imported` is final: a later poll of an older
 * job, or a stale hash-check, must not move a row back out of it.
 */
async function applyVerdict(db, hash, verdict) {
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
  await db(JOURNAL).where({ hash }).whereNot({ state: STATE.IMPORTED }).update(patch);
}

/** The request itself failed; the file was not judged. */
async function recordTransportFailure(db, hashes, message) {
  if (!hashes.length) return;
  const stamp = now();
  await db(JOURNAL)
    .whereIn('hash', hashes)
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

/** Park every row that has used up its attempts without reaching a verdict. */
async function parkExhausted(db, maxAttempts) {
  await db(JOURNAL)
    .whereNotIn('state', [STATE.IMPORTED, STATE.PARKED])
    .where('attempts', '>=', maxAttempts)
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
  ensureSchema,
  getByHashes,
  upsertPending,
  markUploaded,
  applyVerdict,
  recordTransportFailure,
  parkExhausted,
  listPendingJobIds,
  listAll,
  resetAll,
  fileCacheGet,
  fileCacheSet,
};
