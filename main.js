// Modules to control application life and create native browser window
const electron = require('electron');
const { app, BrowserWindow, dialog, Tray, Menu, powerMonitor } = electron;
const { ipcMain } = electron;
require('@electron/remote/main').initialize();

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
// TODO: enable auto updater after setting up code signing key
// const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
// 1 MB with one rotation (the default) is a couple of days of hourly runs.
log.transports.file.maxSize = 5 * 1024 * 1024;
// A crash must leave a trace. With these handlers Electron's blocking
// "A JavaScript error occurred in the main process" dialog is not shown
// either — on an unattended machine that dialog froze the whole app.
process.on('uncaughtException', (error) => log.error('Uncaught exception:', error));
process.on('unhandledRejection', (reason) => log.error('Unhandled rejection:', reason));
const AutoLaunch = require('auto-launch');

const dbConfig = require('./models/settings');
const setting = require('./setting');
const packageJson = require('./package.json');
const { gatherSyncFiles } = require('./sync/gather');
const hasher = require('./sync/hasher');
const { createApi, describeError } = require('./sync/api');
const { planUpload, batchForUpload } = require('./sync/plan');

function getCustomHeaders() {
  return {
    'Client-Type': 'roadsoft-uploader',
    'App-Version': packageJson.version,
    Platform: process.platform,
  };
}

const PLATFORMS = Object.freeze({ MAC: 'darwin', WIN: 'win32' });

// Bulk API constants
const BULK_BATCH_SIZE = 100; // the server's MAX_FILES_PER_REQUEST
/**
 * The server buffers a whole multipart request in memory and refuses one whose
 * Content-Length exceeds 200 MiB (`bulk-upload-aggregate-size.guard.ts`,
 * MAX_TACHO_BULK_UPLOAD_AGGREGATE_BYTES). Batches are cut well under it, so
 * a folder of large vehicle-unit downloads travels in several requests.
 */
const BULK_BATCH_BYTES = 150 * 1024 * 1024;
/**
 * The server's per-file cap on this endpoint (`MAX_BUFFERED_FILE_BYTES`: the
 * parser's 6 MiB plus 1 MiB of slack). Multer aborts the WHOLE request with 413
 * when one part is over it — nothing in the batch is stored. Such a file is
 * therefore never sent: it goes to Failed/ with the reason, and its 99
 * neighbours upload normally.
 */
const MAX_UPLOAD_FILE_BYTES = 7 * 1024 * 1024;
const BULK_RETRY_DELAY_MS = 30000; // 30 seconds
const BULK_MAX_RETRIES = 20;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let mainWindow;
let companyIdentifier = '';
let apiKey = '';
let lastSync = '';
let folderPath = '';
let scheduleId;
let tray = null;
let lastScheduleCheck = Date.now();
let scheduleInterval = null; // in milliseconds
let isWindowVisible = true;

// main.log is the file support asks a customer to send. The server echoes the
// API key back in some error messages ("API key not found. [apiKey=…]"), so
// every line is scrubbed of the current key before it is written.
log.hooks.push((message) => {
  if (apiKey) {
    message.data = message.data.map((part) => (typeof part === 'string' ? part.split(apiKey).join('***') : part));
  }
  return message;
});

// TODO: enable auto updater after setting up code signing key
// autoUpdater.autoDownload = false;
// autoUpdater.autoInstallOnAppQuit = true;

async function preset() {
  // preload persisted settings from local DB so renderer can request them fast
  apiKey = await dbConfig.getSetting('api_key');
  companyIdentifier = await dbConfig.getSetting('company_id');
  lastSync = await dbConfig.getSetting('last_sync');
  folderPath = await dbConfig.getSetting('folder_path');
}

function createWindow(startMinimized = false) {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
    icon: path.join(__dirname, 'frontend/images/app-512-bg-w.png'),
    show: false,
  });

  require('@electron/remote/main').enable(mainWindow.webContents);

  mainWindow.loadFile(path.join(__dirname, 'frontend/index.html'));

  if (startMinimized) {
    // Don't show or maximize, just hide to tray
    mainWindow.hide();
    if (tray) {
      tray.displayBalloon({
        title: 'RoadSoft',
        content: 'Application started in system tray',
      });
    }
  } else {
    mainWindow.maximize();
    mainWindow.show();
  }

  preset();

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
    if (tray && process.platform === PLATFORMS.WIN) {
      tray.displayBalloon({ title: 'RoadSoft', content: 'The app has been minimized to the system tray' });
    }
  });

  // Handle window visibility changes for Windows sync fix
  mainWindow.on('hide', () => {
    isWindowVisible = false;
    log.info('Window hidden - sync continues in background');
  });

  mainWindow.on('show', () => {
    isWindowVisible = true;
    log.info('Window shown - sync continues normally');
  });

  mainWindow.on('close', (event) => {
    event.preventDefault();

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Exit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Confirm exit',
      message: 'Would you like to exit the app?',
    });

    if (choice === 0) {
      // Clean up timers before exit
      if (scheduleId) {
        clearInterval(scheduleId);
      }
      app.exit(0);
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'frontend/images/logo_w.png'));
  tray.setToolTip('RoadSoft');
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: function () {
        mainWindow.show();
        mainWindow.maximize();
      },
    },
    {
      label: 'Quit',
      click: function () {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.show();
    mainWindow.maximize();
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  // Load auto-start preferences from DB
  let autoStartEnabled = await dbConfig.getSetting('auto_start_enabled');
  const startMinimized = await dbConfig.getSetting('start_minimized');

  // First start on this machine: auto-start is ON unless the user turns it off.
  // Earlier versions left the setting unset on a fresh install, and `null` meant "do
  // nothing", so after a server reboot the app did not come back until someone
  // started it by hand (RS-6238). The 1.0.x builds enabled auto-launch on every
  // start; this restores that default while keeping the checkbox as the opt-out.
  if (autoStartEnabled === null || autoStartEnabled === undefined) {
    autoStartEnabled = 'true';
    await dbConfig.setSetting('auto_start_enabled', 'true');
  }

  log.info(
    `RoadSoft ${app.getVersion()} starting: platform=${process.platform} packaged=${app.isPackaged} ` +
      `userData=${app.getPath('userData')} autoStart=${autoStartEnabled} startMinimized=${startMinimized}`,
  );

  // Auto-launch only works in production (packaged app)
  if (app.isPackaged) {
    const autoLaunch = new AutoLaunch({
      name: 'roadsoft',
      path: app.getPath('exe'),
    });

    // Only enable/disable based on user preference
    try {
      if (autoStartEnabled === 'true') {
        await autoLaunch.enable();
      } else if (autoStartEnabled === 'false') {
        await autoLaunch.disable();
      }
      // If null/undefined, do nothing (first run - let user decide)
    } catch (err) {
      log.error('Auto-launch error:', err.message);
    }
  } else {
    log.info('Auto-launch disabled in development mode');
  }

  createWindow(startMinimized === 'true');
  createTray();

  app.on('activate', function () {
    // On macOS, clicking the dock icon should show the window
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
      mainWindow.maximize();
    }
  });

  // TODO: enable auto updater after setting up code signing key
  // autoUpdater.checkForUpdatesAndNotify();

  // Handle system resume from sleep/suspend
  powerMonitor.on('resume', () => {
    log.info('System resumed from sleep');

    // Check if we missed a scheduled sync
    const timeSinceLastCheck = Date.now() - lastScheduleCheck;

    if (scheduleId && scheduleInterval && timeSinceLastCheck >= scheduleInterval) {
      log.info('Missed sync during sleep, triggering now');
      sendLog('System resumed - checking for missed sync...');

      // Validate folder path before syncing
      if (folderPath && fs.existsSync(folderPath)) {
        syncFolder(folderPath);
      }

      lastScheduleCheck = Date.now();
    } else if (scheduleId && scheduleInterval) {
      // System woke up BEFORE the scheduled time
      // setInterval may be unreliable after sleep, so restart it
      log.info('Restarting scheduler after sleep to ensure reliability');

      // Calculate remaining time until next sync
      const remainingTime = scheduleInterval - timeSinceLastCheck;

      // Clear old interval
      clearInterval(scheduleId);

      // Set new interval with remaining time for first run, then normal interval
      scheduleId = setTimeout(() => {
        lastScheduleCheck = Date.now();
        if (folderPath && fs.existsSync(folderPath)) {
          syncFolder(folderPath);
        }

        // After first sync, switch to regular interval
        scheduleId = setInterval(() => {
          lastScheduleCheck = Date.now();
          if (folderPath && fs.existsSync(folderPath)) {
            syncFolder(folderPath);
          } else {
            sendLog('Error: Folder path is invalid or no longer exists');
          }
        }, scheduleInterval);
      }, remainingTime);

      sendLog(`Scheduler restarted, next sync in ${Math.round(remainingTime / 60000)} minutes`);
    }
  });

  // Optional: log when system is about to sleep
  powerMonitor.on('suspend', () => {
    log.info('System is going to sleep');
  });
});

/* ===================================== Auto Update ===================================== */
// TODO: enable auto updater after setting up code signing key
// autoUpdater.on('update-available', () => {
//   log.info('update-available');
//   autoUpdater.downloadUpdate();
// });
//
// autoUpdater.on('checking-for-update', () => {
//   log.info('checking-for-update');
// });
//
// autoUpdater.on('error', (message) => {
//   log.info('error');
//   log.info(typeof message);
//   log.info(message);
// });
//
// autoUpdater.on('update-downloaded', () => {
//   log.info('update-downloaded');
// });
//
// end of auto update
app.on('window-all-closed', function () {
  if (process.platform !== PLATFORMS.MAC) app.quit();
});

/* ===================================== IPC Communication ===================================== */

//pre sets
ipcMain.on('dbConfig:getPreset', async () => {
  const syncSchedule = await dbConfig.getSetting('sync_schedule');

  mainWindow.webContents.send('dbConfig:setPreset', {
    companyIdentifier,
    apiKey,
    lastSync,
    folderPath,
    syncSchedule,
  });
});

// validate credentials against API and persist them locally
ipcMain.on('config:authenticate', async (e, data) => {
  await connect(data.companyIdentifier, data.apiKey);
});

ipcMain.on('dbConfig:setFolderPath', async (e, newFolderPath) => {
  if (newFolderPath) {
    folderPath = newFolderPath;
    dbConfig.setSetting('folder_path', newFolderPath);
  }
});

// previous schedule - also handles auto-reconnect on startup
ipcMain.on('sync:previousSchedule', async () => {
  const scheduleTrigger = await dbConfig.getSetting('sync_schedule');

  log.info(
    `Startup: trigger=${scheduleTrigger || 'manual'} folder=${folderPath || '(none)'} ` +
      `credentials=${companyIdentifier && apiKey ? 'yes' : 'no'}`,
  );

  // Always try to reconnect if we have credentials (fixes "not connected" on restart)
  if (companyIdentifier && apiKey) {
    const connection = await connect(companyIdentifier, apiKey);
    if (!connection) log.warn('Startup connect failed; the schedule is not armed until the next Connect');

    // Only restore schedule if connection succeeded and we have a folder
    if (connection && folderPath && scheduleTrigger) {
      mainWindow.webContents.send('system:log', 'Sync scheduled: ' + scheduleTrigger);

      if (scheduleTrigger == 'application_start') {
        if (scheduleId) {
          try {
            clearInterval(scheduleId);
          } catch (error) {}
        }
        syncFolder(folderPath);
      } else if (scheduleTrigger == '1H') {
        scheduleSyncOnHour(1);
      } else if (scheduleTrigger == '12H') {
        scheduleSyncOnHour(12);
      } else if (scheduleTrigger == '24H') {
        scheduleSyncOnHour(24);
      } else {
        if (scheduleId) {
          try {
            clearInterval(scheduleId);
          } catch (error) {}
        }
      }
    }
  }
});

async function connect(company_id, api_key) {
  const config = {
    method: 'get',
    url: `${setting.baseUrl}/api/v2/tachofile/import/company/${company_id}/verify`,
    headers: {
      'API-KEY': api_key,
      ...getCustomHeaders(),
    },
  };

  try {
    const response = await axios(config);

    if (response) {
      apiKey = api_key;
      companyIdentifier = company_id;
      dbConfig.setSetting('api_key', apiKey);
      dbConfig.setSetting('company_id', companyIdentifier);
      dbConfig.refreshLastSync();
      mainWindow.webContents.send('config:success');
      log.info('Connected');

      return true;
    }
  } catch (error) {
    log.warn(`Connect failed: ${describeError(error)}`);
    mainWindow.webContents.send('config:error', error?.response?.data?.message || 'Cannot connect');

    return false;
  }
}

ipcMain.on('sync:schedule', async (_, trigger) => {
  await dbConfig.setSetting('sync_schedule', trigger);
  log.info(`Schedule set by user: ${trigger || 'manual'}`);
  if (trigger == 'application_start') {
    if (scheduleId) {
      try {
        clearInterval(scheduleId);
      } catch (error) {}
    }
    syncFolder(folderPath);
  } else if (trigger == '1H') {
    scheduleSyncOnHour(1);
  } else if (trigger == '12H') {
    scheduleSyncOnHour(12);
  } else if (trigger == '24H') {
    scheduleSyncOnHour(24);
  } else {
    if (scheduleId) {
      try {
        clearInterval(scheduleId);
      } catch (error) {}
    }
  }
});

function scheduleSyncOnHour(hour) {
  // remove old task if
  if (scheduleId) {
    try {
      clearInterval(scheduleId);
    } catch (error) {}
  }

  scheduleInterval = hour * 60 * 60 * 1000;
  lastScheduleCheck = Date.now();
  log.info(`Schedule armed: every ${hour}h`);

  scheduleId = setInterval(() => {
    lastScheduleCheck = Date.now();

    // Check if folder path is still valid
    if (folderPath && fs.existsSync(folderPath)) {
      syncFolder(folderPath);

      // On Windows, log when sync happens while window is hidden
      if (process.platform === PLATFORMS.WIN && !isWindowVisible) {
        log.info('Sync completed while window hidden');
      }
    } else {
      sendLog('Error: Folder path is invalid or no longer exists');
    }
  }, scheduleInterval);
}

ipcMain.on('sync:start', async () => {
  const connection = await connect(companyIdentifier, apiKey);
  if (connection) syncFolder(folderPath);
});

/* ===================================== SYNC LOGIC (updated) ===================================== */
/** `outcome` is 'Success', 'Failed' (a server verdict) or 'Not sent' (stays in the folder, retried next run). */
function logFileResult(file, outcome, note = '') {
  const logFilePath = path.join(app.getPath('userData'), 'log.txt');

  if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, '', { flag: 'w' });
  }

  const status = note ? `${outcome}: ${note}` : outcome;
  fs.appendFileSync(logFilePath, `[${new Date().toLocaleString()}] (${status}) ${path.basename(file)}\n`);
}

function generateSyncSummary(stats) {
  const parts = [];
  if (stats.uploaded > 0) {
    // Files and uploads differ when copies of one file were collapsed into one request.
    const uploads = stats.uploads !== stats.uploaded ? ` (${stats.uploads} uploaded)` : '';
    parts.push(`Successfully synced: ${stats.uploaded}${uploads}`);
  }
  if (stats.alreadyOnServer > 0) parts.push(`Already on server: ${stats.alreadyOnServer}`);
  if (stats.rejected > 0) parts.push(`Rejected by server: ${stats.rejected}`);
  if (stats.unknown > 0) parts.push(`Unknown server answer, skipped: ${stats.unknown}`);
  if (stats.notSent > 0) parts.push(`Not sent, retry next run: ${stats.notSent}`);
  if (stats.unreadable > 0) parts.push(`Unreadable, retry next run: ${stats.unreadable}`);
  return parts.length ? `${parts.join(' | ')} files` : 'Nothing to sync';
}

/** One line to the window AND to main.log — the textarea is never read on an unattended machine. */
function sendLog(message) {
  log.info(message);
  mainWindow.webContents.send('system:log', message);
}

/** The same `sync:updateStatus` for every path that holds these bytes. */
function reportEntry(entry, stats, key, payload) {
  for (const filePath of entry.paths) {
    stats[key] += 1;
    mainWindow.webContents.send('sync:updateStatus', { ...payload, fileName: filePath });
  }
}

/** `true` while a run is in flight. Runs are triggered from several places (the
 * hourly interval, resume from sleep, Sync Now, the start-up trigger); two at
 * once would hash, ask and upload the same files twice and race each other on
 * the moves. There is deliberately no request timeout, so a stalled run can
 * outlast the interval — the guard is what keeps the next tick from stacking. */
let syncInProgress = false;

async function syncFolder(folder) {
  if (!folder) {
    sendLog('No folder selected for sync.');
    return;
  }

  // Check if folder exists
  if (!fs.existsSync(folder)) {
    sendLog(`Error: Selected folder does not exist: ${folder}`);
    return;
  }
  if (syncInProgress) {
    sendLog('A sync is already running; this trigger is skipped.');
    return;
  }
  syncInProgress = true;
  try {
    await runSync(folder);
  } finally {
    syncInProgress = false;
  }
}

/**
 * Resolves when the renderer reports `channel`, or after `fallbackMs` if it
 * never does (window gone, renderer stuck) — the run must not hang on the UI.
 * The listener is registered BEFORE the request that triggers the reply.
 */
function waitForRenderer(channel, fallbackMs) {
  return new Promise((resolve) => {
    const onEvent = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, onEvent);
      log.warn(`Renderer did not report ${channel} within ${fallbackMs / 1000}s; continuing`);
      resolve(false);
    }, fallbackMs);
    ipcMain.once(channel, onEvent);
  });
}

async function runSync(folder) {
  const startedAt = Date.now();

  // Ask the renderer to rebuild its file table. That pass also extracts any
  // zip archives, so the folder is read only once the renderer says it is
  // done — a fixed two-second wait used to let a still-extracting file be
  // hashed and uploaded half-written.
  const filesReady = waitForRenderer('sync:filesReady', 60_000);
  mainWindow.webContents.send('sync:updateFiles');
  await filesReady;
  mainWindow.webContents.send('sync:changeStatusToProcessing');
  sendLog('Processing sync..');

  // collect all .ddd / .esm from root + subfolders (depth up to 10)
  const filesToSync = gatherSyncFiles(folder);

  if (filesToSync.length === 0) {
    sendLog('No files to sync');
    // An idle folder is a completed run, not a stall: "Last Sync at" advances.
    mainWindow.webContents.send('system:update-last-sync', new Date().toLocaleString());
    return;
  }

  // 1. Fingerprint every file (md5 of the bytes — the digest the server derives),
  //    grouping copies: two paths with the same bytes are one entry, one upload.
  let unreadable = 0;
  const entries = await hasher.hashAll(filesToSync, (filePath, error) => {
    unreadable += 1;
    sendLog(`Skipped this run, could not read ${filePath}: ${error.code ?? error.message}`);
  });
  if (entries.length === 0) {
    sendLog(
      unreadable ? `No readable files to sync (${unreadable} unreadable, retry next run)` : 'No readable files to sync',
    );
    mainWindow.webContents.send('system:update-last-sync', new Date().toLocaleString());
    return;
  }

  // 2. Ask the server which of these it already knows. This is what ends a
  //    re-upload loop: the Archived/ move below is a convenience that can fail
  //    (locked file, synced or network folder), and in earlier versions it was the only
  //    thing between a file and its next upload (RS-7317). The server, not the
  //    app, remembers — nothing is stored locally.
  sendLog(`Checking ${entries.length} file(s) with the server..`);
  const api = createApi({ baseUrl: setting.baseUrl, companyIdentifier, apiKey, headers: getCustomHeaders() });
  let answers;
  try {
    answers = await api.hashCheck(entries.map((entry) => entry.hash));
  } catch (error) {
    // Without the answer nothing may be sent — uploading blind is the loop this
    // check exists to stop. Files stay where they are; the next run asks again.
    // An HTTP answer is not "unreachable": say what the server said, and call
    // out a 404 — a server without hash-check would otherwise look like a
    // network problem for ever.
    if (error?.response?.status === 404) {
      sendLog(
        `This server has no hash-check endpoint (HTTP 404); nothing is uploaded until it does: ${describeError(error)}`,
      );
    } else if (error?.unexpectedBody) {
      sendLog(
        `The server's answer was not a file list (a proxy or a login page in the way?), sync postponed: ${error.message}`,
      );
    } else if (error?.response) {
      sendLog(`Server refused the hash check, sync postponed: ${describeError(error)}`);
    } else {
      sendLog(`Server unreachable, sync postponed: ${describeError(error)}`);
    }
    return;
  }
  const plan = planUpload(entries, answers);
  sendLog(
    `Already on server: ${plan.alreadyImported.length}, rejected by server: ${plan.rejected.length}, to upload: ${plan.toUpload.length}`,
  );
  if (plan.unknown.length) {
    const statuses = [...new Set(plan.unknown.map((entry) => entry.status))].join(', ');
    sendLog(
      `${plan.unknown.length} file(s) skipped this run: the server answered with a status this version does not know (${statuses}). Update the application.`,
    );
  }

  const syncStats = { uploaded: 0, uploads: 0, alreadyOnServer: 0, rejected: 0, unknown: 0, notSent: 0, unreadable };

  // 3. Files the server already holds go to Archived/ without an upload; files it
  //    has permanently refused go to Failed/, with the server's verdict as the label.
  for (const entry of plan.alreadyImported) {
    reportEntry(entry, syncStats, 'alreadyOnServer', { code: 200, status: 'Synced', label: 'Already on server' });
    entry.paths.forEach((filePath) => logFileResult(filePath, 'Success', 'already on server'));
  }
  for (const entry of plan.rejected) {
    reportEntry(entry, syncStats, 'rejected', { code: 200, status: 'Not Synced', label: 'Rejected by server' });
    entry.paths.forEach((filePath) => logFileResult(filePath, 'Failed', 'rejected by server'));
  }
  for (const entry of plan.unknown) {
    reportEntry(entry, syncStats, 'unknown', {
      code: 200,
      status: 'Not Synced',
      move: false,
      label: `Not synced — unknown server answer (${entry.status})`,
    });
    entry.paths.forEach((filePath) => logFileResult(filePath, 'Not sent', `unknown server answer ${entry.status}`));
  }

  // 4. Upload the rest — one path per entry, at most 100 files and 150 MiB per
  //    request. A file over the server's per-file cap is not sent at all: the
  //    server would answer 413 for the whole request and nothing in it would be
  //    stored, so the batch would be offered again next run, for ever.
  const oversized = plan.toUpload.filter((entry) => entry.size > MAX_UPLOAD_FILE_BYTES);
  for (const entry of oversized) {
    const mib = (entry.size / (1024 * 1024)).toFixed(1);
    sendLog(`Rejected, larger than the server accepts: ${entry.fileName} (${mib} MiB, limit 7 MiB)`);
    reportEntry(entry, syncStats, 'rejected', {
      code: 413,
      status: 'Not Synced',
      label: `Rejected — ${mib} MiB, larger than the server accepts (7 MiB)`,
    });
    entry.paths.forEach((filePath) => logFileResult(filePath, 'Failed', `${mib} MiB, larger than the server accepts`));
  }
  const batches = batchForUpload(
    plan.toUpload.filter((entry) => entry.size <= MAX_UPLOAD_FILE_BYTES),
    { maxFiles: BULK_BATCH_SIZE, maxBytes: BULK_BATCH_BYTES },
  );

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    // Prepare FormData with files (rebuilt on retry: a stream can be read once).
    // Every part declares its length, so the request carries a Content-Length
    // instead of streaming chunked: that header is what lets the server refuse
    // an oversized batch before buffering it (two production out-of-memory
    // crashes were traced to this client's chunked uploads).
    const buildForm = () => {
      const form = new FormData();
      for (const entry of batch) {
        form.append('files', fs.createReadStream(entry.paths[0]), {
          filename: entry.fileName,
          knownLength: entry.size,
        });
      }
      return form;
    };
    let formData = buildForm();

    // Send with retry on queue overflow
    let retries = 0;
    let shouldExitRetryLoop = false;

    while (!shouldExitRetryLoop && retries < BULK_MAX_RETRIES) {
      try {
        const response = await axios({
          method: 'post',
          url: `${setting.baseUrl}/api/v2/tachofile/import/company/${companyIdentifier}/bulk`,
          headers: {
            'API-KEY': apiKey,
            ...formData.getHeaders(),
            'Content-Length': formData.getLengthSync(),
            ...getCustomHeaders(),
          },
          data: formData,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });

        if (response.data && response.data.jobId) {
          // Success — update status for all files in batch
          for (const entry of batch) {
            syncStats.uploads += 1;
            reportEntry(entry, syncStats, 'uploaded', { code: 200, message: 'Synced successfully', status: 'Synced' });
            entry.paths.forEach((filePath) => logFileResult(filePath, 'Success'));
          }
        } else {
          // A 2xx without a receipt is not an upload the server recorded (a
          // proxy page, most likely). Said so, and the files stay for next run.
          log.error(
            `Batch ${batchIndex + 1}/${batches.length}: HTTP ${response.status} without a jobId, not counted as sent`,
          );
          for (const entry of batch) {
            reportEntry(entry, syncStats, 'notSent', {
              code: response.status,
              status: 'Not Synced',
              move: false,
              label: 'Not synced — server answered without a receipt (retry next run)',
            });
            entry.paths.forEach((filePath) => logFileResult(filePath, 'Not sent', 'no receipt from server'));
          }
        }
        shouldExitRetryLoop = true;
      } catch (error) {
        const codeName = error.response?.data?.codeName;

        if (codeName === 'file-upload/too-many-files-in-queue') {
          retries++;
          if (retries >= BULK_MAX_RETRIES) break; // no point sleeping after the last try
          sendLog(`Queue full, waiting ${BULK_RETRY_DELAY_MS / 1000}s... (${retries}/${BULK_MAX_RETRIES})`);
          await delay(BULK_RETRY_DELAY_MS);
          formData = buildForm();
        } else {
          // Other error — the request failed, so the server never saw these
          // bytes. The files STAY in the folder and are offered again next run;
          // a Failed/ move here would retire, for good, files the server could
          // not have recorded and so can never recover. Failed/ is for a server
          // verdict on the bytes (plan.rejected) and for corrupt archives only.
          const reason = describeError(error);
          log.error(`Batch ${batchIndex + 1}/${batches.length} not sent: ${reason}`);
          for (const entry of batch) {
            reportEntry(entry, syncStats, 'notSent', {
              code: error.response?.status || 500,
              message: error.message || 'Error occurred by API',
              status: 'Not Synced',
              move: false,
              label: `Not synced — ${reason} (retry next run)`,
            });
            entry.paths.forEach((filePath) => logFileResult(filePath, 'Not sent', reason));
          }
          shouldExitRetryLoop = true; // Exit retry loop
        }
      }
    }

    // Max retries exceeded — the queue is still full; the files stay and the next run tries again
    if (!shouldExitRetryLoop) {
      for (const entry of batch) {
        reportEntry(entry, syncStats, 'notSent', {
          code: 503,
          message: 'Max retries exceeded',
          status: 'Not Synced',
          move: false,
          label: 'Not synced — server queue full (retry next run)',
        });
        entry.paths.forEach((filePath) => logFileResult(filePath, 'Not sent', 'server queue full'));
      }
    }

    sendLog(`Batch ${batchIndex + 1}/${batches.length} complete`);
  }

  // Final summary message
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  sendLog(`${generateSyncSummary(syncStats)} (${seconds}s)`);

  // tell renderer to update "last sync" timestamp in UI
  mainWindow.webContents.send('system:update-last-sync', new Date().toLocaleString());
}

// Every line the renderer writes to its textarea (unzip, moves, guards) also
// lands in main.log — the textarea is never read on an unattended machine.
ipcMain.on('log:write', (e, message) => {
  log.info(`[renderer] ${message}`);
});

ipcMain.on('app:getVersion', () => {
  mainWindow.webContents.send('app:setVersion', app.getVersion());
});

/* ===================================== Startup Settings IPC ===================================== */

ipcMain.on('settings:setAutoStart', async (e, enabled) => {
  await dbConfig.setSetting('auto_start_enabled', enabled ? 'true' : 'false');

  // If auto-start is disabled, also disable start minimized
  if (!enabled) {
    await dbConfig.setSetting('start_minimized', 'false');
  }

  // Auto-launch only works in production (packaged app)
  if (app.isPackaged) {
    const autoLaunch = new AutoLaunch({
      name: 'roadsoft',
      path: app.getPath('exe'),
    });

    try {
      if (enabled) {
        await autoLaunch.enable();
      } else {
        await autoLaunch.disable();
      }
      mainWindow.webContents.send('system:log', `Auto-start ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      log.error('Auto-launch error:', err.message);
      mainWindow.webContents.send('system:log', `Auto-start error: ${err.message}`);
    }
  } else {
    mainWindow.webContents.send(
      'system:log',
      `Auto-start ${enabled ? 'enabled' : 'disabled'} (dev mode - will work in production)`,
    );
  }
});

ipcMain.on('settings:setStartMinimized', async (e, minimized) => {
  await dbConfig.setSetting('start_minimized', minimized ? 'true' : 'false');
  mainWindow.webContents.send('system:log', `Start minimized ${minimized ? 'enabled' : 'disabled'}`);
});

// Add handler to get current settings
ipcMain.on('settings:getStartupPreferences', async () => {
  const autoStartEnabled = await dbConfig.getSetting('auto_start_enabled');
  const startMinimized = await dbConfig.getSetting('start_minimized');

  mainWindow.webContents.send('settings:setStartupPreferences', {
    autoStartEnabled: autoStartEnabled === 'true',
    startMinimized: startMinimized === 'true',
  });
});

module.exports = { gatherSyncFiles }; // exported for potential tests
