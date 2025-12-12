/* eslint-disable no-useless-escape */
const electron = require('electron');
const { ipcRenderer } = electron;
const { app, dialog } = require('@electron/remote');
const fs = require('fs');
const path = require('path');
const extractZip = require('extract-zip');
const trash = require('trash');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SCAN_DEPTH = 10;

const DIRS = Object.freeze({ ARCHIVED: 'Archived', FAILED: 'Failed' });
const EXT = Object.freeze({ ZIP: '.zip', DDD: '.ddd', ESM: '.esm' });
const BATCH_SIZE = 100;

let connected = false;

// Performance optimization: Set for O(1) lookup instead of O(n) DataTable search
const addedFilePaths = new Set();
// Batching: accumulate rows and flush every BATCH_SIZE
let pendingRows = [];

// DataTable init
const filesDataTable = $('#dtBasicExample').DataTable({
  columnDefs: [{ width: '10%', targets: 0 }],
  ordering: true,
});
$('.dataTables_length').addClass('bs-select');

addLog('Welcome to RoadSoft File Sync Utility');

// ============================ Initial settings ============================
ipcRenderer.send('dbConfig:getPreset');

ipcRenderer.on('dbConfig:setPreset', (e, data) => {
  $('#company-id').val(data.companyId);
  $('#api-key').val(data.apiKey);
  $('#last-sync').text(data.lastSync);
  $('#folder-path').text(data.folderPath);
  $('label[for="company-id"]').addClass('active');
  $('label[for="api-key"]').addClass('active');
  // Select schedule option safely
  if (data.syncSchedule) {
    $(`#trigger option[value='${data.syncSchedule}']`).attr('selected', 'selected');
  }
  if (data.folderPath) {
    getFilesFromFolder(data.folderPath);
  }
});

// check for schedule
setTimeout(() => {
  ipcRenderer.send('sync:previousSchedule');
}, 1500);

ipcRenderer.on('sync:changeStatusToProcessing', () => {
  changeStatusToProcessing();
});

// =============================== Connect =================================
$('#connect').on('click', function () {
  connected = false;
  const companyId = $('#company-id').val();
  const apiKey = $('#api-key').val();

  if (!companyId || !apiKey) {
    addLog('Please fill company identifier and api key.');
    return;
  }

  if (!UUID_REGEX.test(companyId)) {
    addLog('Company Identifier format is invalid. Example: 123e4567-e89b-12d3-a456-426614174000');
    return;
  }

  ipcRenderer.send('config:authenticate', { companyId, apiKey });
});

ipcRenderer.on('sync:updateFiles', () => {
  const folderPath = $('#folder-path').text();
  if (folderPath) {
    getFilesFromFolder(folderPath);
  }
});

ipcRenderer.on('config:success', () => {
  connected = true;
  addLog('Connected');
});

ipcRenderer.on('config:error', (e, error) => {
  if (error) {
    addLog(error);
  } else {
    addLog('Cannot connect');
  }
});

// ============================= Folder choose =============================
$('#select-folder').on('click', async function () {
  const pathDlg = await dialog.showOpenDialog({ properties: ['openDirectory'] });

  if (!pathDlg.canceled) {
    const folderPath = pathDlg.filePaths[0];

    $('#folder-path').text(folderPath);
    getFilesFromFolder(folderPath);
    ipcRenderer.send('dbConfig:setFolderPath', folderPath);
  }
});

/* =========================================================================
   PATH GUARDS (CRITICAL)
   ========================================================================= */

/** Resolve path with realpath (symlinks) and fallback to path.resolve. */
function realResolve(p) {
  try {
    // Use native if available
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Check that `candidate` path is strictly inside `rootDir`.
 * - Uses real paths to avoid symlink escape.
 * - Allows equality (candidate === rootDir) only when explicitly needed by caller.
 */
function isPathInside(rootDir, candidate) {
  const root = realResolve(rootDir);
  const target = realResolve(candidate);
  if (root === target) return true;
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* =========================================================================
   FILE DISCOVERY + UNZIP (NO BUFFERS)
   ========================================================================= */

/** Ensure special folders exist at root path. */
function ensureSpecialFolders(rootPath) {
  const archivedDir = path.join(rootPath, DIRS.ARCHIVED);
  const failedDir = path.join(rootPath, DIRS.FAILED);

  if (!fs.existsSync(archivedDir)) {
    fs.mkdirSync(archivedDir);
  }
  if (!fs.existsSync(failedDir)) {
    fs.mkdirSync(failedDir);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Check if a row for the given absolute path already exists in the table. */
function hasRowFor(fullPath) {
  return addedFilePaths.has(fullPath);
}

/**
 * Recursively walk "dirPath" (max depth 10):
 * - unzip any .zip we encounter (including nested zips)
 * - immediately add every .ddd/.esm found as a row (no intermediate arrays/Sets)
 * - skip top-level "Archived" and "Failed"
 * NOTE: all deletions here are guarded to remain within `rootPath`.
 */
async function scanAndUnpack(rootPath, dirPath, depth) {
  if (depth > MAX_SCAN_DEPTH) return;

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    addLog(`Error reading dir ${dirPath}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);

    // Skip "Archived" and "Failed" at root level
    if (
      depth === 0 &&
      entry.isDirectory() &&
      (entry.name.toLowerCase() === DIRS.ARCHIVED.toLowerCase() ||
        entry.name.toLowerCase() === DIRS.FAILED.toLowerCase())
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      await scanAndUnpack(rootPath, full, depth + 1);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (ext === EXT.ZIP) {
      // snapshot before
      const beforeNames = new Set();
      try {
        fs.readdirSync(dirPath).forEach((n) => beforeNames.add(n));
      } catch (snapErr) {
        addLog(`Error snapshotting dir ${dirPath}: ${snapErr.message}`);
      }

      try {
        // Extract into current directory
        await extractZip(full, { dir: dirPath });
        // Move original archive to trash (recoverable)
        await trash(full);
        addLog(`[Unzip] Extracted ${entry.name}, original moved to trash`);
        // Rescan current directory (do not increase depth)
        await scanAndUnpack(rootPath, dirPath, depth);
      } catch (zipErr) {
        // Cleanup any partially created items (STRICTLY within root) - move to trash
        let afterNames = [];
        try {
          afterNames = fs.readdirSync(dirPath);
        } catch (afterErr) {
          addLog(`Error resnapshotting dir ${dirPath}: ${afterErr.message}`);
        }

        const newlyCreated = afterNames.filter((name) => !beforeNames.has(name));

        // Move partially created items to trash instead of permanent deletion
        for (const name of newlyCreated) {
          const targetPath = path.join(dirPath, name);
          // Guard: only remove within the chosen root
          if (!isPathInside(rootPath, targetPath) && realResolve(targetPath) !== realResolve(rootPath)) {
            addLog(`[Guard] Skip cleanup outside root: ${targetPath}`);
            continue;
          }
          if (!fs.existsSync(targetPath)) continue;
          try {
            await trash(targetPath);
            addLog(`[Trash] Moved partial file to trash: ${targetPath}`);
          } catch (cleanupErr) {
            addLog(`Cleanup error for ${targetPath}: ${cleanupErr.message}`);
          }
        }

        // Move bad zip to /Failed (guarded)
        const failedDir = path.join(rootPath, DIRS.FAILED);
        if (!fs.existsSync(failedDir)) {
          fs.mkdirSync(failedDir);
        }
        const failedTarget = path.join(failedDir, path.basename(full));

        // Guard: both src and dst must be within root (src is in dirPath which is under root)
        if (isPathInside(rootPath, failedTarget)) {
          try {
            fs.renameSync(full, failedTarget);
          } catch (moveErr) {}
        } else {
          addLog(`[Guard] Skip moving failed zip outside root: ${failedTarget}`);
        }
      }
    } else if (ext === EXT.DDD || ext === EXT.ESM) {
      // Immediately add row for this file if not present already
      if (!hasRowFor(full)) {
        const relative = path.relative(rootPath, full);
        addNewFile(full, relative);
      }
    }
  }
}

async function getFilesFromFolder(folderPath) {
  // Rebuild table (fresh list of files)
  filesDataTable.clear().draw();

  // Clear tracking Set and pending batch for fresh scan
  addedFilePaths.clear();
  pendingRows = [];

  const root = realResolve(folderPath);
  ensureSpecialFolders(root);

  // Incremental walk: rows are added on the fly (no collectors)
  await scanAndUnpack(root, root, 0);

  // Flush any remaining rows after scan completes
  flushPendingRows();
}

function addNewFile(fullPath, relativeDisplay) {
  // Add to Set for O(1) lookup
  addedFilePaths.add(fullPath);

  // Accumulate row data for batching
  pendingRows.push([
    // Hidden cell with absolute path for easy lookup
    `<span style="display:none" class="file-fullpath" data-path="${escapeHtml(
      fullPath,
    )}">${escapeHtml(fullPath)}</span>`,
    // Visible name
    `<i class="fa fa-file-text"></i>&nbsp;&nbsp; ${escapeHtml(relativeDisplay)}`,
    // Status
    'Not Synced',
  ]);

  // Flush batch when reaching BATCH_SIZE
  if (pendingRows.length >= BATCH_SIZE) {
    flushPendingRows();
  }
}

/**
 * Flush accumulated rows to DataTable in one batch.
 * This reduces DOM operations from N to N/BATCH_SIZE.
 */
function flushPendingRows() {
  if (pendingRows.length === 0) return;
  pendingRows.forEach((row) => filesDataTable.row.add(row));
  filesDataTable.draw(false);
  pendingRows = [];
}

/* =========================================================================
   SCHEDULING / SYNC BUTTONS
   ========================================================================= */

$('#schedule-sync').on('click', function () {
  const folderPath = $('#folder-path').text();
  if (!folderPath) {
    addLog('Error: Select folder first');
    return;
  }
  if (!connected) {
    addLog('Error: Please connect first');
    return;
  }
  addLog('Added task in the schedule');
  const trigger = $('#trigger option:selected').val();
  ipcRenderer.send('sync:schedule', trigger);
});

$('#sync-now').on('click', function () {
  const folderPath = $('#folder-path').text();
  if (!folderPath) {
    addLog('Error: Select folder first');
    return;
  }
  if (!connected) {
    addLog('Error: Please connect first');
    return;
  }
  addLog('Starting sync...');
  ipcRenderer.send('sync:start');
});

/* =========================================================================
   TABLE STATUS UPDATES
   ========================================================================= */

/** Flip all rows to "Synchronizing" at sync start (row-wise, not a full rebuild). */
function changeStatusToProcessing() {
  filesDataTable.rows((idx, data) => {
    if (data[2] === 'Not Synced' || /Synchro/i.test(String(data[2]))) {
      filesDataTable
        .row(idx)
        .data([data[0], data[1], '<i class="fa fa-refresh fa-spin"></i>&nbsp;&nbsp; Synchronizing'])
        .draw(false);
    }
  });
}

/**
 * Safe remove helper (overwrite support, ROOT-GUARDED).
 * Moves a file or directory to trash if it exists, but only if it's inside `rootGuard`.
 * Uses trash package for cross-platform support (works with folders on Windows).
 * Note: This is async but called in fire-and-forget manner for compatibility with existing code.
 */
function removePathRecursiveSyncSafe(targetPath, rootGuard) {
  // Guard: never allow deletions outside selected root
  if (!isPathInside(rootGuard, targetPath) && realResolve(targetPath) !== realResolve(rootGuard)) {
    addLog(`[Guard] Refusing to remove outside root: ${targetPath}`);
    return;
  }
  if (!fs.existsSync(targetPath)) return;

  trash(targetPath)
    .then(() => {
      addLog(`[Trash] Moved to trash: ${targetPath}`);
    })
    .catch((err) => {
      addLog(`Trash error for ${targetPath}: ${err.message}`);
    });
}

/**
 * Per-file status update:
 * - find the row by hidden absolute path cell
 * - move file or its top-level folder to Archived/Failed (ONLY within chosen root)
 * - update only that row's status
 * - overwrite behavior is atomic: delete destination first, with root guard
 */
ipcRenderer.on('sync:updateStatus', function (event, data) {
  const absoluteFilePath = data.fileName;
  const rootFolder = $('#folder-path').text();

  // Resolve paths once
  const rootResolved = realResolve(rootFolder);
  const fileResolved = realResolve(absoluteFilePath);

  // Guard 1: never operate on a file outside of the chosen root
  if (!isPathInside(rootResolved, fileResolved)) {
    addLog(`[Guard] Skip moving outside root: ${absoluteFilePath}`);
  } else {
    const rowIndexes = filesDataTable
      .rows()
      .indexes()
      .filter(function (value) {
        const rowData = filesDataTable.row(value).data();
        return rowData[0].includes(absoluteFilePath);
      });

    // Move file/folder into Archived or Failed
    const targetType = data.status === 'Synced' ? DIRS.ARCHIVED : DIRS.FAILED;
    const targetRootDir = path.join(rootResolved, targetType);
    if (!fs.existsSync(targetRootDir)) {
      fs.mkdirSync(targetRootDir);
    }

    if (fs.existsSync(fileResolved)) {
      const relFromRoot = path.relative(rootResolved, fileResolved);
      const parts = relFromRoot.split(path.sep).filter(Boolean); // drop empty parts

      if (parts.length === 1) {
        // Top-level file
        const destFilePath = path.join(targetRootDir, path.basename(fileResolved));

        // Guard 2: destination must be inside targetRootDir
        if (isPathInside(targetRootDir, destFilePath) || realResolve(destFilePath) === realResolve(targetRootDir)) {
          // Ensure overwrite semantics on all platforms
          if (fs.existsSync(destFilePath)) {
            removePathRecursiveSyncSafe(destFilePath, rootResolved);
          }
          fs.rename(fileResolved, destFilePath, (err) => {
            if (err) addLog(`Error moving file: ${err?.message}`);
          });
        } else {
          addLog(`[Guard] Refuse to move top-level file outside target dir: ${destFilePath}`);
        }
      } else {
        // File is inside a subfolder: move entire top-level folder
        const topLevelFolderName = parts[0];

        // Guard 3: first segment cannot be "." or ".." and must be a plain name
        if (!topLevelFolderName || topLevelFolderName === '.' || topLevelFolderName === '..') {
          addLog(`[Guard] Invalid top-level name for move: "${topLevelFolderName}" from ${relFromRoot}`);
        } else {
          const srcTopFolderPath = path.join(rootResolved, topLevelFolderName);
          const destTopFolderPath = path.join(targetRootDir, topLevelFolderName);

          // Guard 4: both src and dest must be inside root / targetRootDir respectively
          const srcOk =
            isPathInside(rootResolved, srcTopFolderPath) || realResolve(srcTopFolderPath) === realResolve(rootResolved);
          const dstOk =
            isPathInside(targetRootDir, destTopFolderPath) ||
            realResolve(destTopFolderPath) === realResolve(targetRootDir);

          if (srcOk && dstOk && fs.existsSync(srcTopFolderPath)) {
            if (fs.existsSync(destTopFolderPath)) {
              removePathRecursiveSyncSafe(destTopFolderPath, rootResolved);
            }
            fs.rename(srcTopFolderPath, destTopFolderPath, (err) => {
              if (err) addLog(`Error moving folder: ${err?.message}`);
            });
          } else {
            addLog(
              `[Guard] Refuse to move folder. srcOk=${srcOk} dstOk=${dstOk} src=${srcTopFolderPath} dst=${destTopFolderPath}`,
            );
          }
        }
      }
    }

    if (rowIndexes && rowIndexes.length > 0) {
      const rowIdx = rowIndexes[0];
      const rowData = filesDataTable.row(rowIdx).data();
      filesDataTable.row(rowIdx).data([rowData[0], rowData[1], data.status]).draw(false);
    }
  }
});

// ================================ System logs =============================
ipcRenderer.on('system:log', function (event, data) {
  addLog(data);
});

ipcRenderer.on('system:update-last-sync', function (event, data) {
  $('#last-sync').text(data);
});

// ============================== Quick open links ==========================
$('#folder-path').on('click', function (e) {
  e.preventDefault();
  const folder = $('#folder-path').text();

  if (folder) {
    shell.openPath(folder);
  }
});

$('#open-log').on('click', function (e) {
  e.preventDefault();

  const logFilePath = path.join(app.getPath('userData'), 'log.txt');

  if (!fs.existsSync(logFilePath)) {
    return;
  }

  // Always open local log.txt in CWD as before
  shell.openPath(logFilePath);
});

/* =========================================================================
   MISC HELPERS
   ========================================================================= */

function addLog(msg) {
  $('#logArea').append(msg + '\n');
  $('#logArea').scrollTop($('#logArea')[0].scrollHeight);
}

ipcRenderer.send('app:getVersion');

ipcRenderer.on('app:setVersion', (e, version) => {
  $('title').text(`${$('title').text()} v${version}`);
});

/* =========================================================================
   STARTUP PREFERENCES
   ========================================================================= */

// Add event listeners for checkboxes
$('#auto-start-enabled').on('change', function () {
  const enabled = $(this).is(':checked');
  ipcRenderer.send('settings:setAutoStart', enabled);

  // Control "Start minimized" availability based on "Auto-start"
  if (enabled) {
    // Enable "Start minimized" checkbox
    $('#start-minimized').prop('disabled', false);
    $('label[for="start-minimized"]').css('opacity', '1');
  } else {
    // Disable and uncheck "Start minimized" checkbox
    $('#start-minimized').prop('disabled', true);
    $('#start-minimized').prop('checked', false);
    $('label[for="start-minimized"]').css('opacity', '0.5');
    // Save to database
    ipcRenderer.send('settings:setStartMinimized', false);
  }
});

$('#start-minimized').on('change', function () {
  const minimized = $(this).is(':checked');
  ipcRenderer.send('settings:setStartMinimized', minimized);
});

// Load preferences on startup
ipcRenderer.send('settings:getStartupPreferences');

ipcRenderer.on('settings:setStartupPreferences', (e, data) => {
  $('#auto-start-enabled').prop('checked', data.autoStartEnabled);
  $('#start-minimized').prop('checked', data.startMinimized);

  // Set "Start minimized" disabled state based on "Auto-start"
  if (data.autoStartEnabled) {
    $('#start-minimized').prop('disabled', false);
    $('label[for="start-minimized"]').css('opacity', '1');
  } else {
    $('#start-minimized').prop('disabled', true);
    $('label[for="start-minimized"]').css('opacity', '0.5');
  }
});
