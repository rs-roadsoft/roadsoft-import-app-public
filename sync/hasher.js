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
    let size;
    try {
      ({ size } = await fs.promises.stat(filePath));
      hash = await hashFile(filePath);
    } catch (error) {
      onUnreadable(filePath, error);
      continue;
    }
    const name = path.basename(filePath);
    // `size` is what the upload declares as Content-Length and what bounds a
    // batch by bytes; copies share it, since they share the bytes.
    const entry = byHash.get(hash) ?? { hash, fileName: name, size, paths: [] };
    entry.paths.push(filePath);
    // The name sent to the server is the SHORTEST of the copies' names, ties
    // broken alphabetically — deterministic, and it picks `M_1.DDD` over the
    // `M_1 (1).DDD` a file manager gives a duplicate. The server reads the
    // download date out of the name, so which copy names the upload matters.
    if (name.length < entry.fileName.length || (name.length === entry.fileName.length && name < entry.fileName)) {
      entry.fileName = name;
    }
    byHash.set(hash, entry);
  }
  return [...byHash.values()];
}

module.exports = { hashFile, hashAll };
