// Modules to control application life and create native browser window
const electron = require('electron');
const { app, BrowserWindow, dialog, Tray, Menu, powerMonitor } = electron;
const { ipcMain } = electron;
require('@electron/remote/main').initialize();

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const AutoLaunch = require('auto-launch');

const dbConfig = require('./models/settings');
const setting = require('./setting');
const packageJson = require('./package.json');

function getCustomHeaders() {
  return {
    'Client-Type': 'roadsoft-uploader',
    'App-Version': packageJson.version,
    Platform: process.platform,
  };
}

const MAX_SCAN_DEPTH = 10;
const DIRS = Object.freeze({ ARCHIVED: 'Archived', FAILED: 'Failed' });
const EXT = Object.freeze({ DDD: '.ddd', ESM: '.esm' });
const PLATFORMS = Object.freeze({ MAC: 'darwin', WIN: 'win32' });

let mainWindow;
let companyId = '';
let apiKey = '';
let lastSync = '';
let folderPath = '';
let scheduleId;
let tray = null;
let lastScheduleCheck = Date.now();
let scheduleInterval = null; // in milliseconds
let isWindowVisible = true;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

async function preset() {
  // preload persisted settings from local DB so renderer can request them fast
  apiKey = await dbConfig.getSetting('api_key');
  companyId = await dbConfig.getSetting('company_id');
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
    },
    icon: path.join(__dirname, 'frontend/images/app-512.png'),
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
  tray = new Tray(path.join(__dirname, 'frontend/images/app.png'));
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
  const autoStartEnabled = await dbConfig.getSetting('auto_start_enabled');
  const startMinimized = await dbConfig.getSetting('start_minimized');

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

  // trigger auto updater on startup
  autoUpdater.checkForUpdatesAndNotify();

  // Handle system resume from sleep/suspend
  powerMonitor.on('resume', () => {
    log.info('System resumed from sleep');

    // Check if we missed a scheduled sync
    const timeSinceLastCheck = Date.now() - lastScheduleCheck;

    if (scheduleId && scheduleInterval && timeSinceLastCheck >= scheduleInterval) {
      log.info('Missed sync during sleep, triggering now');
      mainWindow.webContents.send('system:log', 'System resumed - checking for missed sync...');

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
            mainWindow.webContents.send('system:log', 'Error: Folder path is invalid or no longer exists');
          }
        }, scheduleInterval);
      }, remainingTime);

      mainWindow.webContents.send(
        'system:log',
        `Scheduler restarted, next sync in ${Math.round(remainingTime / 60000)} minutes`,
      );
    }
  });

  // Optional: log when system is about to sleep
  powerMonitor.on('suspend', () => {
    log.info('System is going to sleep');
  });
});

/* ===================================== Auto Update ===================================== */
autoUpdater.on('update-available', () => {
  log.info('update-available');
  autoUpdater.downloadUpdate();
});

autoUpdater.on('checking-for-update', () => {
  log.info('checking-for-update');
});

autoUpdater.on('error', (message) => {
  log.info('error');
  log.info(typeof message);
  log.info(message);
});

autoUpdater.on('update-downloaded', () => {
  log.info('update-downloaded');
});

// end of auto update
app.on('window-all-closed', function () {
  if (process.platform !== PLATFORMS.MAC) app.quit();
});

/* ===================================== HELPER: collect files recursively ===================================== */
/**
 * Recursively walk a directory (depth-limited) and collect .ddd/.esm files from all subfolders (including nested subfolders).
 * - Skips the special folders "Archived" and "Failed" at the top level.
 * - Max depth: 10
 * NOTE: main process only READS files; all moving/deleting is handled (safely) in renderer with path guards.
 */
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

  entries.forEach((entry) => {
    const fullPath = path.join(currentDir, entry.name);

    // Skip special folders "Archived" and "Failed" from the root level
    if (
      depth === 0 &&
      (entry.name.toLowerCase() === DIRS.ARCHIVED.toLowerCase() ||
        entry.name.toLowerCase() === DIRS.FAILED.toLowerCase()) &&
      entry.isDirectory()
    ) {
      return;
    }

    if (entry.isDirectory()) {
      gatherSyncFiles(rootDir, fullPath, depth + 1, maxDepth, collected);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === EXT.DDD || ext === EXT.ESM) {
        collected.push(fullPath);
      }
    }
  });

  return collected;
}

/* ===================================== IPC Communication ===================================== */

//pre sets
ipcMain.on('dbConfig:getPreset', async () => {
  const syncSchedule = await dbConfig.getSetting('sync_schedule');

  mainWindow.webContents.send('dbConfig:setPreset', {
    companyId,
    apiKey,
    lastSync,
    folderPath,
    syncSchedule,
  });
});

// validate credentials against API and persist them locally
ipcMain.on('config:authenticate', async (e, data) => {
  await connect(data.companyId, data.apiKey);
});

ipcMain.on('dbConfig:setFolderPath', async (e, newFolderPath) => {
  if (newFolderPath) {
    folderPath = newFolderPath;
    dbConfig.setSetting('folder_path', newFolderPath);
  }
});

// previous schedule
ipcMain.on('sync:previousSchedule', async () => {
  const scheduleTrigger = await dbConfig.getSetting('sync_schedule');

  if (scheduleTrigger && folderPath) {
    mainWindow.webContents.send('system:log', 'Sync scheduled: ' + scheduleTrigger);

    const connection = await connect(companyId, apiKey);

    if (connection) {
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
      companyId = company_id;
      dbConfig.setSetting('api_key', apiKey);
      dbConfig.setSetting('company_id', companyId);
      dbConfig.refreshLastSync();
      mainWindow.webContents.send('config:success');

      return true;
    }
  } catch (error) {
    console.log(error.message);
    mainWindow.webContents.send('config:error', error?.response?.data?.message || 'Cannot connect');

    return false;
  }
}

ipcMain.on('sync:schedule', async (_, trigger) => {
  await dbConfig.setSetting('sync_schedule', trigger);
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
      mainWindow.webContents.send('system:log', 'Error: Folder path is invalid or no longer exists');
    }
  }, scheduleInterval);
}

ipcMain.on('sync:start', async () => {
  const connection = await connect(companyId, apiKey);
  if (connection) syncFolder(folderPath);
});

/* ===================================== SYNC LOGIC (updated) ===================================== */
async function syncFolder(folder) {
  if (!folder) {
    mainWindow.webContents.send('system:log', 'No folder selected for sync.');
    return;
  }

  // Check if folder exists
  if (!fs.existsSync(folder)) {
    mainWindow.webContents.send('system:log', `Error: Selected folder does not exist: ${folder}`);
    return;
  }

  // ask renderer to rebuild its file table (will also trigger unzip logic there)
  mainWindow.webContents.send('sync:updateFiles');

  await wait(2000);
  mainWindow.webContents.send('sync:changeStatusToProcessing');
  mainWindow.webContents.send('system:log', 'Processing sync..');

  // collect all .ddd / .esm from root + subfolders (depth up to 10)
  const filesToSync = gatherSyncFiles(folder);

  // upload each file to the API using axios.then() so renderer can update per-file status
  filesToSync.forEach((file) => {
    const data = JSON.stringify({
      fileName: path.basename(file),
      downloadDate: new Date().toISOString().split('.')[0],
      fileBytes: fs.readFileSync(file, { encoding: 'base64' }),
    });

    const config = {
      method: 'post',
      url: `${setting.baseUrl}/api/v2/tachofile/import/company/${companyId}`,
      headers: {
        'API-KEY': apiKey,
        'Content-Type': 'application/json',
        ...getCustomHeaders(),
      },
      data,
    };

    axios(config)
      .then(function (response) {
        if (response.data.jobId) {
          mainWindow.webContents.send('sync:updateStatus', {
            code: 200,
            message: 'Synced successfully',
            fileName: file,
            status: 'Synced',
          });
        } else {
          mainWindow.webContents.send('sync:updateStatus', {
            code: response.status,
            message: 'Error occured by API',
            fileName: file,
            status: 'Not Synced',
          });
        }
      })
      .catch(function (error) {
        console.log('Error: ', error);
        mainWindow.webContents.send('sync:updateStatus', {
          code: 500,
          message: 'Error occured by API',
          fileName: file,
          status: 'Not Synced',
        });
      });

    const logFilePath = path.join(app.getPath('userData'), 'log.txt');

    if (!fs.existsSync(logFilePath)) {
      fs.writeFileSync(logFilePath, '', { flag: 'w' });
    }

    fs.appendFileSync(logFilePath, `[${new Date().toLocaleString()}] (Success) ${path.basename(file)}\n`);
  });

  // tell renderer to update "last sync" timestamp in UI
  mainWindow.webContents.send('system:update-last-sync', new Date().toLocaleString());
}

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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log('Done waiting');
      resolve(ms);
    }, ms);
  });
}

module.exports = { gatherSyncFiles }; // exported for potential tests
