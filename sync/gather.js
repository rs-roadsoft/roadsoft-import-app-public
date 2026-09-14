/**
 * The folder walk: every `.ddd` / `.esm` under the chosen root, depth-limited,
 * skipping the top-level `Archived` and `Failed` folders the renderer moves
 * files into.
 *
 * Moved out of `main.js` unchanged so the sync can be tested without Electron.
 * The main process only READS files; all moving is done in the renderer with
 * path guards.
 */
const fs = require('fs');
const path = require('path');

const MAX_SCAN_DEPTH = 10;
const DIRS = Object.freeze({ ARCHIVED: 'Archived', FAILED: 'Failed' });
const EXT = Object.freeze({ DDD: '.ddd', ESM: '.esm' });

function isSpecialTopLevelDir(entry, depth) {
  return (
    depth === 0 &&
    entry.isDirectory() &&
    (entry.name.toLowerCase() === DIRS.ARCHIVED.toLowerCase() || entry.name.toLowerCase() === DIRS.FAILED.toLowerCase())
  );
}

function gatherSyncFiles(rootDir, currentDir = rootDir, depth = 0, maxDepth = MAX_SCAN_DEPTH, collected = []) {
  if (depth > maxDepth) {
    return collected;
  }

  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch (err) {
    console.log('Error reading dir:', currentDir, err.message);
    return collected;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (isSpecialTopLevelDir(entry, depth)) continue;

    if (entry.isDirectory()) {
      gatherSyncFiles(rootDir, fullPath, depth + 1, maxDepth, collected);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === EXT.DDD || ext === EXT.ESM) {
      collected.push(fullPath);
    }
  }

  return collected;
}

module.exports = { gatherSyncFiles, MAX_SCAN_DEPTH, DIRS, EXT };
