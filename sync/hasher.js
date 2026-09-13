/**
 * The content hash that ties a file to its journal row.
 *
 * md5 of the raw bytes — the same digest the server derives
 * (`Import.generateHash` in `apps/be/src/entities/import.entity.ts`), so the
 * value the journal stores is the value `hash-check` and the job poll answer
 * with. Streamed, not buffered: a folder can hold thousands of files and
 * nothing here needs more than one in memory.
 *
 * The cache exists because a scheduled run re-walks the whole folder every
 * hour. Hashing a few thousand unchanged files each time is hundreds of
 * megabytes of disk read for no new information; size plus mtime is enough to
 * know the bytes are the ones already hashed.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const journal = require('../models/journal');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash('md5');
    fs.createReadStream(filePath)
      .on('data', (chunk) => digest.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(digest.digest('hex')));
  });
}

async function hashWithCache(db, filePath) {
  const stat = await fs.promises.stat(filePath);
  const cached = await journal.fileCacheGet(db, filePath);
  if (cached && cached.size === stat.size && Number(cached.mtime_ms) === Math.floor(stat.mtimeMs)) {
    return cached.hash;
  }
  const hash = await hashFile(filePath);
  await journal.fileCacheSet(db, { path: filePath, size: stat.size, mtime_ms: Math.floor(stat.mtimeMs), hash });
  return hash;
}

/**
 * Hash every path and group by content. Two copies of one file — a restored
 * backup beside the original, the shape measured on production — become one
 * entry with two paths, so the journal sees one file and the upload sends it
 * once.
 */
async function hashAll(db, filePaths, onUnreadable = () => {}) {
  const byHash = new Map();
  for (const filePath of filePaths) {
    let hash;
    try {
      hash = await hashWithCache(db, filePath);
    } catch (error) {
      // A file that cannot be read right now — still being copied in (EBUSY,
      // EPERM on Windows), or removed by the renderer's unzip pass between the
      // walk and the read (ENOENT). It is skipped for THIS run and picked up by
      // the next; without this one locked file aborted the whole run, and kept
      // aborting it for as long as the lock held.
      onUnreadable(filePath, error);
      continue;
    }
    const entry = byHash.get(hash) ?? { hash, fileName: path.basename(filePath), paths: [] };
    entry.paths.push(filePath);
    byHash.set(hash, entry);
  }
  return [...byHash.values()];
}

module.exports = { hashFile, hashWithCache, hashAll };
