/**
 * Pure mapping from what the server says about a file to what the journal
 * records about it. No I/O, so every branch is unit-testable.
 *
 * Two server signals feed this, and they answer different questions:
 *
 * - `hash-check` (before upload) answers "should I send these bytes?". It is
 *   the authority on skipping: it says PERMANENTLY_FAILED for any REJECTED row
 *   whatever the code, and ALREADY_IMPORTED for a successful, staged or
 *   in-flight one.
 * - the job poll (after upload) answers "what happened to what I sent?". It
 *   carries the backend's own reason (`error.name` / `error.message`), which
 *   hash-check does not. Its status is collapsed to WAITING / FAILED / DONE by
 *   the server, so an intake rejection and a decode failure both read FAILED
 *   here; the code inside `error` tells them apart.
 */

const STATE = Object.freeze({
  PENDING: 'pending',
  UPLOADED: 'uploaded',
  IMPORTED: 'imported',
  PARKED: 'parked',
});

const HASH_CHECK_STATUS = Object.freeze({
  ALREADY_IMPORTED: 'ALREADY_IMPORTED',
  PERMANENTLY_FAILED: 'PERMANENTLY_FAILED',
  NOT_IMPORTED: 'NOT_IMPORTED',
});

const JOB_FILE_STATUS = Object.freeze({
  WAITING: 'WAITING',
  FAILED: 'FAILED',
  DONE: 'DONE',
});

const REASON_SOURCE = Object.freeze({
  // The text came from the server: the import row's error object.
  BACKEND: 'backend',
  // No server verdict exists — the request itself failed. The HTTP error is
  // stored so the row still explains itself, but it is not a judgement on the
  // file and the row stays eligible for retry.
  TRANSPORT: 'transport',
});

/** Upload attempts before a file that never reached a verdict is parked. */
const MAX_ATTEMPTS = 3;

/**
 * Error codes the backend treats as final: a re-submission of these bytes is
 * refused at intake before anything is stored, so uploading again can only
 * produce another refusal.
 *
 * Mirrors `PERMANENT_IMPORT_ERROR_CODES` in
 * `apps/be/src/constants/permanent-import-error-codes.ts`. Nothing links the
 * two at build time; when that list changes, this one must follow.
 */
const PERMANENT_ERROR_CODES = Object.freeze(
  new Set([
    'file-upload/upload-not-allowed/already-exists',
    'file-upload/file-for-period-already-processed',
    'file-upload/unable-to-decode',
    'file-upload/not-a-tachograph-file',
  ]),
);

function isPermanentCode(name) {
  return typeof name === 'string' && PERMANENT_ERROR_CODES.has(name);
}

/**
 * What a hash-check status means for the journal. `null` means "upload it" —
 * the file is not terminal on the server and nothing about it changes here.
 */
function fromHashCheck(status) {
  switch (status) {
    case HASH_CHECK_STATUS.ALREADY_IMPORTED:
      return { state: STATE.IMPORTED, verdict: status };
    case HASH_CHECK_STATUS.PERMANENTLY_FAILED:
      return { state: STATE.PARKED, verdict: status };
    default:
      return null;
  }
}

/**
 * What one file of a job poll means for the journal.
 *
 * A FAILED file whose code is not permanent stays `uploaded`: the backend will
 * accept those bytes again, and the attempt counter — not this mapping —
 * decides when to stop trying. The reason is recorded either way, so the row
 * explains itself while it waits.
 */
function fromJobFile(file) {
  const reasonName = file?.error?.name ?? null;
  const reasonMessage = file?.error?.message ?? null;
  const hasReason = reasonName !== null || reasonMessage !== null;
  const reason = hasReason ? { reasonName, reasonMessage, reasonSource: REASON_SOURCE.BACKEND } : {};

  switch (file?.status) {
    case JOB_FILE_STATUS.DONE:
      return { state: STATE.IMPORTED, verdict: file.status, ...reason };
    case JOB_FILE_STATUS.FAILED:
      return {
        state: isPermanentCode(reasonName) ? STATE.PARKED : STATE.UPLOADED,
        verdict: file.status,
        ...reason,
      };
    default:
      return { state: STATE.UPLOADED, verdict: JOB_FILE_STATUS.WAITING, ...reason };
  }
}

/** A row that has been tried enough times without ever being imported. */
function shouldPark(row) {
  return row.state !== STATE.IMPORTED && row.state !== STATE.PARKED && row.attempts >= MAX_ATTEMPTS;
}

/** Whether a row is one the sync must never send again. */
function isTerminal(row) {
  return row.state === STATE.IMPORTED || row.state === STATE.PARKED;
}

/** The status text the file table shows for a row. */
function describe(row) {
  // A backend reason has a code and a message; a transport failure has only a
  // message. Either alone is worth showing.
  const reason = [row.reason_name, row.reason_message].filter(Boolean).join(': ');
  switch (row.state) {
    case STATE.IMPORTED:
      return 'Imported';
    case STATE.PARKED:
      return reason ? `Parked — ${reason}` : `Parked — ${row.verdict ?? 'no verdict'}`;
    case STATE.UPLOADED:
      return reason ? `Uploaded — ${reason}` : 'Uploaded — waiting for verdict';
    default:
      return reason ? `Not synced — ${reason} (attempt ${row.attempts})` : 'Not synced';
  }
}

module.exports = {
  STATE,
  HASH_CHECK_STATUS,
  JOB_FILE_STATUS,
  REASON_SOURCE,
  MAX_ATTEMPTS,
  PERMANENT_ERROR_CODES,
  isPermanentCode,
  fromHashCheck,
  fromJobFile,
  shouldPark,
  isTerminal,
  describe,
};
