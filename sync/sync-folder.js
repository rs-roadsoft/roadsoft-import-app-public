/**
 * One scheduled run: what the folder holds, what the server already knows,
 * what still needs sending, and what came of it.
 *
 * The order is the design. Verdicts for last run's uploads are collected
 * FIRST, so a file the importer refused an hour ago is parked with its reason
 * before this run could send it again. Then every file is hashed and looked
 * up in the journal; only rows that are not terminal are asked about, and only
 * the ones the server calls NOT_IMPORTED are sent. A file is tethered to its
 * content: two copies on disk are one journal row and one upload.
 *
 * Nothing here touches Electron. `main.js` supplies the folder walk, the
 * logger, the API and the status callback, which is what lets the whole flow
 * run under `node --test` against a temp folder and a fake server.
 */
const { BULK_BATCH_SIZE, describeError } = require('./api');
const hasher = require('./hasher');
const journal = require('../models/journal');
const verdicts = require('./verdicts');

const { STATE, MAX_ATTEMPTS } = verdicts;

function chunk(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) {
    result.push(array.slice(index, index + size));
  }
  return result;
}

/** `true` while a run is in flight; a second trigger during it is refused. */
let syncInProgress = false;

/** For the Reset button: clearing the journal under a running sync crashes it. */
function isSyncInProgress() {
  return syncInProgress;
}

/**
 * Ask the server what became of every job that still has a file waiting, and
 * write the answers down. Best-effort: a failed poll leaves the rows as they
 * are and the next run asks again.
 */
async function settleOpenJobs({ db, api, log }) {
  const jobIds = await journal.listPendingJobIds(db);
  for (const jobId of jobIds) {
    try {
      const files = await api.getJobFiles(jobId);
      for (const file of files) {
        if (!file?.hash) continue;
        await journal.applyVerdict(db, file.hash, verdicts.fromJobFile(file));
      }
    } catch (error) {
      log(`Could not fetch verdicts for job ${jobId}: ${describeError(error)}`);
    }
  }
}

/**
 * Upload one batch and record the outcome — the receipt on success, a transport
 * failure for every file otherwise. Then poll the job once: intake refusals
 * are final immediately, and this is what puts their reason in the journal
 * without waiting an hour.
 */
async function uploadOne({ db, api, log }, entries) {
  const paths = entries.map((entry) => entry.paths[0]);
  const hashes = entries.map((entry) => entry.hash);
  try {
    const receipt = await api.uploadBatch(paths);
    const byHash = new Map((receipt?.files ?? []).map((file) => [file.hash, file]));
    await journal.markUploaded(
      db,
      entries.map((entry) => ({ hash: entry.hash, importId: byHash.get(entry.hash)?.importId ?? null })),
      receipt?.jobId ?? null,
    );
    if (receipt?.jobId) {
      await settleJob({ db, api, log }, receipt.jobId);
    }
    return { sent: entries.length, failed: 0 };
  } catch (error) {
    const reason = describeError(error);
    log(`Batch failed: ${reason}`);
    await journal.recordTransportFailure(db, hashes, reason);
    return { sent: 0, failed: entries.length };
  }
}

async function settleJob({ db, api, log }, jobId) {
  try {
    const files = await api.getJobFiles(jobId);
    for (const file of files) {
      if (!file?.hash) continue;
      await journal.applyVerdict(db, file.hash, verdicts.fromJobFile(file));
    }
  } catch (error) {
    log(`Could not fetch verdicts for job ${jobId}: ${describeError(error)}`);
  }
}

/**
 * Run a sync. Returns counts for the summary line, or `{ refused: true }` when
 * one is already running.
 *
 * `onFileStatus(path, { status, label })` fires once per path at the end:
 * `status` is what the renderer keys its Archived/Failed move on ('Synced' or
 * 'Not Synced'), `label` is the journal's text for the table.
 */
async function runSync({ db, api, folder, gather, log, onFileStatus = () => {} }) {
  if (syncInProgress) {
    log('A sync is already running; this trigger is skipped.');
    // Its own flag. `skipped` is a COUNT on a normal run, and reading it as
    // this flag made every run with one known file look like a refused one —
    // "Last Sync at" stopped updating after the first run.
    return { refused: true };
  }
  syncInProgress = true;
  try {
    await settleOpenJobs({ db, api, log });

    const filePaths = gather(folder);
    if (!filePaths.length) {
      log('No files to sync');
      return { total: 0, sent: 0, skipped: 0, failed: 0 };
    }

    const entries = await hasher.hashAll(db, filePaths, (filePath, error) =>
      log(`Skipped this run, could not read ${filePath}: ${error.code ?? error.message}`),
    );
    await journal.upsertPending(db, entries);
    const rows = await journal.getByHashes(
      db,
      entries.map((entry) => entry.hash),
    );

    // Only rows the journal has not settled are worth a question.
    const open = entries.filter((entry) => !verdicts.isTerminal(rows.get(entry.hash)));
    let answers = new Map();
    if (open.length) {
      try {
        answers = await api.hashCheck(open.map((entry) => entry.hash));
      } catch (error) {
        // The server could not be asked at all. That is not a verdict on any
        // file and not a failed upload of any file, so nothing is counted
        // against anything: a network outage must not walk a folder of good
        // files toward the attempt cap. The run stops here and the next
        // scheduled one asks again.
        log(`Server unreachable, sync postponed: ${describeError(error)}`);
        return { total: entries.length, sent: 0, skipped: 0, failed: 0, unreachable: true };
      }
    }
    const toUpload = [];
    for (const entry of open) {
      const answer = answers.get(entry.hash);
      const verdict = verdicts.fromHashCheck(answer);
      if (!verdict) {
        toUpload.push(entry);
        continue;
      }
      // A row THIS client uploaded and is still waiting on: hash-check says
      // ALREADY_IMPORTED for a staged or in-flight row too, which answers "do
      // not send again" and nothing more. The outcome belongs to the job poll.
      // Recording it as imported here made the row terminal, stopped the poll,
      // and hid a later retryable failure behind an "Imported" label.
      const row = rows.get(entry.hash);
      const awaitingOwnJob = row?.state === STATE.UPLOADED && !!row.job_id;
      if (awaitingOwnJob && verdict.state === STATE.IMPORTED) {
        continue;
      }
      await journal.applyVerdict(db, entry.hash, verdict);
    }

    const counts = { total: entries.length, sent: 0, skipped: entries.length - toUpload.length, failed: 0 };
    const batches = chunk(toUpload, BULK_BATCH_SIZE);
    for (const [index, batch] of batches.entries()) {
      const outcome = await uploadOne({ db, api, log }, batch);
      counts.sent += outcome.sent;
      counts.failed += outcome.failed;
      log(`Batch ${index + 1}/${batches.length} complete`);
    }

    await journal.parkExhausted(db, MAX_ATTEMPTS);

    const finalRows = await journal.getByHashes(
      db,
      entries.map((entry) => entry.hash),
    );
    for (const entry of entries) {
      const row = finalRows.get(entry.hash);
      // Three statuses, and the renderer moves a file only on the two terminal
      // ones: `imported` to Archived/, `parked` to Failed/. Anything still in
      // play stays where it is. Reporting a pending row as 'Not Synced' sent it
      // to Failed/ — a folder the next scan skips — so one network blip parked a
      // whole batch after its first attempt, and the three-run retry the spec
      // promises never had a file left to retry.
      const status = fileStatus(row);
      for (const filePath of entry.paths) {
        onFileStatus(filePath, { status, label: verdicts.describe(row) });
      }
    }
    return counts;
  } finally {
    syncInProgress = false;
  }
}

/** What the renderer keys its Archived/Failed move on. */
function fileStatus(row) {
  switch (row?.state) {
    case STATE.IMPORTED:
      return 'Synced';
    case STATE.PARKED:
      return 'Not Synced';
    default:
      return 'Pending';
  }
}

function summarize(counts) {
  if (counts.refused) return 'Sync skipped: another sync is running';
  if (counts.unreachable) return `Sync postponed: server unreachable, ${counts.total} file(s) left for the next run`;
  const parts = [];
  if (counts.sent) parts.push(`uploaded ${counts.sent}`);
  if (counts.skipped) parts.push(`already known ${counts.skipped}`);
  if (counts.failed) parts.push(`failed ${counts.failed}`);
  return parts.length ? `Sync done: ${parts.join(', ')} of ${counts.total} file(s)` : 'Sync done: nothing to send';
}

module.exports = { runSync, summarize, settleOpenJobs, isSyncInProgress, fileStatus };
