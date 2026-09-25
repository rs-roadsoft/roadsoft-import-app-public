/**
 * Where a settled file goes: the SAME relative path under `Archived/` or
 * `Failed/`. Only the file moves — never its folder.
 *
 * In earlier versions a file inside a subfolder moved its whole top-level folder, which
 * took every not-yet-uploaded sibling along (RS-7303): on Windows the rename
 * failed with EPERM while the main process still streamed the next batch from
 * inside that folder, or it succeeded and the later batches failed with ENOENT,
 * their files stranded in Archived/ where the scan never looks.
 *
 * Pure path arithmetic; the renderer keeps its realpath-based guard on the
 * result. Returns null for anything that is not strictly inside the root.
 */
const fs = require('fs');
const path = require('path');

/** Strictly inside: not the root itself, not outside it, on any platform. */
function isStrictlyInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function moveTargetFor(rootResolved, fileResolved, targetRootDir) {
  if (!isStrictlyInside(rootResolved, fileResolved)) {
    return null;
  }
  const relFromRoot = path.relative(rootResolved, fileResolved);
  return { relFromRoot, destFilePath: path.join(targetRootDir, relFromRoot) };
}

/**
 * After the last file has left a folder, remove the folder — and its now-empty
 * parents — up to, never including, the watched root. `rmdir` only ever removes
 * an EMPTY directory: a folder that still holds anything (another file, a note,
 * a file being written right now) is left alone and the walk stops there.
 *
 * Customers keep one folder per driver (`to_sync/driver_1/…`). In earlier versions the
 * whole folder moved, so it vanished once synced; with per-file moves it would
 * stay behind empty. This keeps the folder's look the same without the old bug.
 */
async function removeEmptyParents(dir, rootResolved) {
  let current = dir;
  // `path.relative`, not a string prefix: a root that already ends with a
  // separator (a drive root such as `E:\`) never matched `root + sep`, so no
  // emptied folder under it was ever removed.
  while (isStrictlyInside(rootResolved, current)) {
    try {
      await fs.promises.rmdir(current);
    } catch (error) {
      return; // not empty, already gone, or not removable — stop here
    }
    current = path.dirname(current);
  }
}

/**
 * A destination that does not overwrite anything. `fs.rename` replaces an
 * existing file on every platform, and the one thing this app must never do is
 * lose a file for good: where the older copy could not go to the recycle bin,
 * the newer one takes a numbered name beside it — `M_1 (1).DDD` — and both stay.
 */
function uniqueDestination(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const stem = path.basename(destPath, ext);
  for (let n = 1; ; n += 1) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

module.exports = { moveTargetFor, removeEmptyParents, isStrictlyInside, uniqueDestination };
