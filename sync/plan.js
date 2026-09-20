/**
 * What the server's answer means for each file. Pure, so every branch is a
 * unit test. The server is the memory: nothing here is stored.
 */
const HASH_CHECK_STATUS = Object.freeze({
  ALREADY_IMPORTED: 'ALREADY_IMPORTED',
  PERMANENTLY_FAILED: 'PERMANENTLY_FAILED',
  NOT_IMPORTED: 'NOT_IMPORTED',
});

/**
 * - ALREADY_IMPORTED: the server holds these bytes (imported, staged or in
 *   flight) — do not send, move to Archived/.
 * - PERMANENTLY_FAILED: the server refused these bytes for good — do not send,
 *   move to Failed/.
 * - NOT_IMPORTED, or no answer for the hash: upload.
 * - any other status: `unknown` — NOT uploaded. A status this build does not
 *   know is most likely a new server state that means "I have it"; treating it
 *   as "send" would turn a server-side addition into a re-upload storm on every
 *   installed copy. The caller logs it; the file is offered again next run.
 */
function planUpload(entries, answers) {
  const plan = { toUpload: [], alreadyImported: [], rejected: [], unknown: [] };
  for (const entry of entries) {
    const status = answers.get(entry.hash);
    switch (status) {
      case HASH_CHECK_STATUS.ALREADY_IMPORTED:
        plan.alreadyImported.push(entry);
        break;
      case HASH_CHECK_STATUS.PERMANENTLY_FAILED:
        plan.rejected.push(entry);
        break;
      case HASH_CHECK_STATUS.NOT_IMPORTED:
      case undefined:
        plan.toUpload.push(entry);
        break;
      default:
        plan.unknown.push({ ...entry, status });
    }
  }
  return plan;
}

module.exports = { HASH_CHECK_STATUS, planUpload };
