const electron = require('electron');
const { ipcRenderer, shell } = electron;
const { dialog } = require('@electron/remote');
const fs = require('fs');
const path = require('path');
const extractZip = require('extract-zip');
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SCAN_DEPTH = 10;
const DIRS = Object.freeze({ ARCHIVED: 'Archived', FAILED: 'Failed' });
const EXT = Object.freeze({ ZIP: '.zip', DDD: '.ddd', ESM: '.esm' });

let connected = false;

const filesDataTable = $('#dtBasicExample').DataTable({ columnDefs: [{ width: '10%', targets: 0 }], ordering: true });
$('.dataTables_length').addClass('bs-select');

addLog('Welcome to RoadSoft File Sync Utility');

// initial settings
ipcRenderer.send('dbConfig:getPreset');

ipcRenderer.on('dbConfig:setPreset', (e, data) => {
  $('#company-id').val(data.companyId);
  $('#api-key').val(data.apiKey);
  $('#last-sync').text(data.lastSync);
  $('#folder-path').text(data.folderPath);
  $(`option[value='${data.syncSchedule}']`).attr('selected', 'selected');

  if (data.folderPath) {
    getFilesFromFolder(data.folderPath);
  }
});

// check for schedule
setTimeout(() => {
  ipcRenderer.send('sync:previousSchedule');
}, 1500);

ipcRenderer.on('sync:changeStatusToProcessing', (e, error) => {
  changeStatusToProcessing();
});

$('#connect').on('click', function () {
  connected = false;
  let companyId = $('#company-id').val();
  let apiKey = $('#api-key').val();

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

ipcRenderer.on('sync:updateFiles', (e, message) => {
  let folderPath = $('#folder-path').text();

  if (folderPath) {
    getFilesFromFolder(folderPath);
  }
});

ipcRenderer.on('config:success', (e, message) => {
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

// Select source folder button
$('#select-folder').on('click', async function () {
  const pathDlg = await dialog.showOpenDialog({ properties: ['openDirectory'] });

  if (!pathDlg.canceled) {
    let folderPath = pathDlg.filePaths[0];

    $('#folder-path').text(folderPath);
    getFilesFromFolder(folderPath);

    ipcRenderer.send('dbConfig:setFolderPath', folderPath);
  }
});

/*
=====================================
        FILE DISCOVERY + UNZIP (NO BUFFERS)
=====================================
*/

// Ensure special folders exist at root path
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

// Check if a row for the given absolute path already exists in the table
function hasRowFor(fullPath) {
  const indexes = filesDataTable
    .rows()
    .indexes()
    .filter((idx) => {
      const rowData = filesDataTable.row(idx).data();
      return rowData && typeof rowData[0] === 'string' && rowData[0].includes(fullPath);
    });
  return indexes.length > 0;
}

/*
 * Recursively walk "dirPath" (max depth 10):
 *  - unzip any .zip we encounter (including nested zips)
 *  - immediately add every .ddd/.esm found as a row (no intermediate arrays/Sets)
 *  - skip top-level "Archived" and "Failed"
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
    } else {
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

          // Remove original archive
          fs.unlinkSync(full);

          addLog(`[Unzip] Extracted ${entry.name}`);

          // Rescan current directory (do not increase depth)
          await scanAndUnpack(rootPath, dirPath, depth);
        } catch (zipErr) {
          addLog(`[Unzip Error] ${entry.name}: ${zipErr.message}`);

          // Cleanup any partially created items
          let afterNames = [];
          try {
            afterNames = fs.readdirSync(dirPath);
          } catch (afterErr) {
            addLog(`Error resnapshotting dir ${dirPath}: ${afterErr.message}`);
          }

          const newlyCreated = afterNames.filter((name) => !beforeNames.has(name));

          const rmRecursiveSafe = (targetPath) => {
            if (!fs.existsSync(targetPath)) return;
            try {
              const stat = fs.statSync(targetPath);
              if (stat.isDirectory()) {
                fs.readdirSync(targetPath).forEach((child) => rmRecursiveSafe(path.join(targetPath, child)));
                fs.rmdirSync(targetPath);
              } else {
                fs.unlinkSync(targetPath);
              }
            } catch (cleanupErr) {
              addLog(`Cleanup error for ${targetPath}: ${cleanupErr.message}`);
            }
          };

          newlyCreated.forEach((name) => rmRecursiveSafe(path.join(dirPath, name)));

          // Move bad zip to /Failed
          const failedDir = path.join(rootPath, DIRS.FAILED);
          if (!fs.existsSync(failedDir)) {
            fs.mkdirSync(failedDir);
          }
          const failedTarget = path.join(failedDir, path.basename(full));
          try {
            fs.renameSync(full, failedTarget);
          } catch (moveErr) {
            addLog(`Error moving failed zip: ${moveErr.message}`);
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
}

async function getFilesFromFolder(folderPath) {
  // Rebuild table (fresh list of files)
  filesDataTable.clear().draw();
  ensureSpecialFolders(folderPath);

  // Incremental walk: rows are added on the fly (no collectors)
  await scanAndUnpack(folderPath, folderPath, 0);
}

function addNewFile(fullPath, relativeDisplay) {
  filesDataTable.row
    .add([
      `<span style="display:none" class="file-fullpath" data-path="${escapeHtml(
        fullPath,
      )}">${escapeHtml(fullPath)}</span>`,
      `<i class="fa fa-file-text"></i>&nbsp;&nbsp; ${relativeDisplay}`,
      'Not Synced',
    ])
    .draw(false);
}

/*
=====================================
        SCHEDULING / SYNC BUTTONS
=====================================
*/

$('#schedule-sync').on('click', function () {
  let folderPath = $('#folder-path').text();

  if (!folderPath) {
    addLog('Error: Select folder first');
    return;
  }

  if (!connected) {
    addLog('Error: Please connect first');
    return;
  }

  addLog('Added task in the schedule');

  let trigger = $('#trigger option:selected').val();

  ipcRenderer.send('sync:schedule', trigger);
});

$('#sync-now').on('click', function () {
  let folderPath = $('#folder-path').text();

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

/*
=====================================
        TABLE STATUS UPDATES
=====================================
*/

// Flip all rows to "Synchronizing" at sync start (row-wise, not a full rebuild)
function changeStatusToProcessing() {
  filesDataTable.rows((idx, data, node) => {
    if (data[2] === 'Not Synced' || /Synchro/i.test(String(data[2]))) {
      filesDataTable
        .row(idx)
        .data([data[0], data[1], '<i class="fa fa-refresh fa-spin"></i>&nbsp;&nbsp; Synchronizing'])
        .draw(false);
    }
  });
}

/* -----------------------------------
 * Safe remove helper (overwrite support)
 * -----------------------------------
 *
 * Removes a file or directory recursively if it exists.
 * This is used to implement "replace if exists" behavior when moving
 * files/folders into Archived/Failed.
 */
function removePathRecursiveSyncSafe(targetPath) {
  if (!fs.existsSync(targetPath)) return;

  try {
    const stat = fs.lstatSync(targetPath);

    if (stat.isDirectory()) {
      // Remove contents first
      fs.readdirSync(targetPath).forEach((name) => {
        removePathRecursiveSyncSafe(path.join(targetPath, name));
      });
      fs.rmdirSync(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }
  } catch (err) {
    addLog(`Remove error for ${targetPath}: ${err.message}`);
  }
}

/*
 * Per-file status update:
 *  - find the row by hidden absolute path cell
 *  - move file or its top-level folder to Archived/Failed
 *  - update only that row's status
 *  - NEW: if destination exists (file or folder) — replace it atomically by removing first
 */
ipcRenderer.on('sync:updateStatus', function (event, data) {
  const absoluteFilePath = data.fileName;
  const rootFolder = $('#folder-path').text();

  const rowIndexes = filesDataTable
    .rows()
    .indexes()
    .filter(function (value) {
      const rowData = filesDataTable.row(value).data();
      return rowData[0].includes(absoluteFilePath);
    });

  // Move file/folder into Archived or Failed
  const targetType = data.status === 'Synced' ? DIRS.ARCHIVED : DIRS.FAILED;
  const targetRootDir = path.join(rootFolder, targetType);

  if (!fs.existsSync(targetRootDir)) {
    fs.mkdirSync(targetRootDir);
  }

  if (fs.existsSync(absoluteFilePath)) {
    const relativeFromRoot = path.relative(rootFolder, absoluteFilePath);
    const parts = relativeFromRoot.split(path.sep);

    if (parts.length === 1) {
      // Top-level file
      const destFilePath = path.join(targetRootDir, path.basename(absoluteFilePath));

      // Ensure overwrite semantics on all platforms
      if (fs.existsSync(destFilePath)) {
        removePathRecursiveSyncSafe(destFilePath);
      }

      fs.rename(absoluteFilePath, destFilePath, (err) => {
        if (err) addLog(`Error moving file: ${err?.message}`);
      });
    } else {
      // File is inside a subfolder: move entire top-level folder
      const topLevelFolderName = parts[0];
      const srcTopFolderPath = path.join(rootFolder, topLevelFolderName);
      const destTopFolderPath = path.join(targetRootDir, topLevelFolderName);

      if (fs.existsSync(srcTopFolderPath)) {
        // NEW: replace destination folder if it already exists
        if (fs.existsSync(destTopFolderPath)) {
          removePathRecursiveSyncSafe(destTopFolderPath);
        }

        fs.rename(srcTopFolderPath, destTopFolderPath, (err) => {
          if (err) addLog(`Error moving folder: ${err?.message}`);
        });
      }
    }
  }

  if (rowIndexes.length > 0) {
    const rowIdx = rowIndexes[0];
    const rowData = filesDataTable.row(rowIdx).data();
    filesDataTable.row(rowIdx).data([rowData[0], rowData[1], data.status]).draw(false);
  }
});

ipcRenderer.on('system:log', function (event, data) {
  addLog(data);
});

ipcRenderer.on('system:update-last-sync', function (event, data) {
  $('#last-sync').text(data);
});

// Click on folder path in UI -> open folder in OS file explorer
$('#folder-path').on('click', function (e) {
  e.preventDefault();

  let folder = $('#folder-path').text();

  if (folder) {
    shell.openPath(folder);
  }
});

// Click on "open-log" link/button -> open local log.txt
$('#open-log').on('click', function (e) {
  e.preventDefault();

  let logFile = $('#open-log').text();

  if (logFile) {
    shell.openPath('log.txt');
  }
});

/*
=====================================
        MISC HELPERS
=====================================
*/

function addLog(msg) {
  $('#logArea').append(msg + '\n');
  $('#logArea').scrollTop($('#logArea')[0].scrollHeight);
}

ipcRenderer.send('app:getVersion');

ipcRenderer.on('app:setVersion', (e, version) => {
  $('title').text(`${$('title').text()} v${version}`);
});
