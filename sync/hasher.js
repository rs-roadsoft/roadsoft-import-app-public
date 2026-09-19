/**
 * The content fingerprint that lets the server recognise a file it has seen.
 *
 * md5 of the raw bytes — the same digest the server derives on intake, so the
 * value sent to `hash-check` is the value the server has stored. Streamed, not
 * buffered: a folder can hold thousands of files and nothing here needs more
 * than one in memory. Stateless on purpose: every run re-hashes the folder,
 * and the server, not the app, remembers what it has.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash('md5');
    fs.createReadStream(filePath)
      .on('data', (chunk) => digest.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(digest.digest('hex')));
  });
}

/**
 * Hash every path and group by content. Two copies of one file — a restored
 * backup beside the original, the shape seen on production — become one entry
 * with two paths, so the file is uploaded once and both copies get its result.
 *
 * A path that cannot be read right now — still being copied in, or removed by
 * the renderer's unzip pass between the walk and the read — is reported through
 * `onUnreadable` and left out of this run; the next run picks it up.
 */
async function hashAll(filePaths, onUnreadable = () => {}) {
  const byHash = new Map();
  for (const filePath of filePaths) {
    let hash;
    try {
      hash = await hashFile(filePath);
    } catch (error) {
      onUnreadable(filePath, error);
      continue;
    }
    const entry = byHash.get(hash) ?? { hash, fileName: path.basename(filePath), paths: [] };
    entry.paths.push(filePath);
    byHash.set(hash, entry);
  }
  return [...byHash.values()];
}

module.exports = { hashFile, hashAll };
