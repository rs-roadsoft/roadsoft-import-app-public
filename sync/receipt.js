/**
 * What the bulk receipt says about each entry that was sent.
 *
 * The server answers 201 with `{ jobId, files: [...] }`, one entry per file:
 * a file it stored carries a `fileId`; a file the intake refused on the spot
 * (not a tachograph file, older than the company's import window) carries
 * none. Older servers answer with `{ jobId }` alone.
 *
 * The receipt is not the verdict — that comes from hash-check on the next run,
 * which answers PERMANENTLY_FAILED for the refused bytes and ALREADY_IMPORTED
 * for bytes the server turned out to hold already. So an entry that was not
 * stored is only left in place; nothing is decided about it here. Before this,
 * a receipt with a jobId counted the whole batch as synced, and a file refused
 * at intake went to Archived/ as "Synced successfully" — the server's refusal
 * never surfaced anywhere (RS-7317).
 */
function classifyReceipt(batch, receipt) {
  const files = receipt?.files;
  if (!Array.isArray(files)) {
    return { stored: [...batch], notStored: [] };
  }
  const storedHashes = new Set(files.filter((file) => file && file.fileId != null).map((file) => file.hash));
  const stored = [];
  const notStored = [];
  for (const entry of batch) {
    (storedHashes.has(entry.hash) ? stored : notStored).push(entry);
  }
  return { stored, notStored };
}

module.exports = { classifyReceipt };
