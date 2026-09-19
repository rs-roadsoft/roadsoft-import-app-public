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
 * - anything else, including no answer: upload.
 */
function planUpload(entries, answers) {
  const plan = { toUpload: [], alreadyImported: [], rejected: [] };
  for (const entry of entries) {
    switch (answers.get(entry.hash)) {
      case HASH_CHECK_STATUS.ALREADY_IMPORTED:
        plan.alreadyImported.push(entry);
        break;
      case HASH_CHECK_STATUS.PERMANENTLY_FAILED:
        plan.rejected.push(entry);
        break;
      default:
        plan.toUpload.push(entry);
    }
  }
  return plan;
}

module.exports = { HASH_CHECK_STATUS, planUpload };
