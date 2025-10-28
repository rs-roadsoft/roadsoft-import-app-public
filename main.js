// Modules to control application life and create native browser window
const electron = require('electron');
const { app, BrowserWindow, Tray, Menu } = electron;
const { ipcMain } = electron;
require('@electron/remote/main').initialize();
var axios = require('axios');
const path = require('path');
const fs = require('fs');
const { autoUpdater, AppUpdater } = require('electron-updater');
const log = require('electron-log');
const AutoLaunch = require('auto-launch');
const dbConfig = require('./models/settings');
const setting = require('./setting');
let mainWindow;
let companyId = '';
let apiKey = '';
let lastSync = '';
let folderPath = '';
let scheduleId;
let tray = null;
let isQuiting;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

async function preset() {
  apiKey = await dbConfig.getSetting('api_key');
  companyId = await dbConfig.getSetting('company_id');
  lastSync = await dbConfig.getSetting('last_sync');
  folderPath = await dbConfig.getSetting('folder_path');
}

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      contextIsolation: false,
    },
    show: false,
  });

  require('@electron/remote/main').enable(mainWindow.webContents);

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'frontend/index.html'));

  mainWindow.maximize();

  mainWindow.show();

  preset();

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
    if (tray) {
      tray.displayBalloon({
        title: 'RoadSoft',
        content: 'The app has been minimized to the system tray',
      });
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'frontend/images/app.png'));
  tray.setToolTip('RoadSoft');

  var contextMenu = Menu.buildFromTemplate([
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
        isQuiting = true;
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

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('before-quit', function () {
    isQuiting = true;
  });

  autoUpdater.checkForUpdatesAndNotify();

  let autoLaunch = new AutoLaunch({
    name: 'roadsoft',
    path: app.getPath('exe'),
  });
  autoLaunch.isEnabled().then((isEnabled) => {
    if (!isEnabled) autoLaunch.enable();
  });
});

/*
=====================================
        Auto Update
=====================================
*/

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

//end of auto update

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

/*
=====================================
        IPC Communication
=====================================
*/
//pre sets
ipcMain.on('dbConfig:getPreset', async () => {
  let syncSchedule = await dbConfig.getSetting('sync_schedule');
  mainWindow.webContents.send('dbConfig:setPreset', { companyId, apiKey, lastSync, folderPath, syncSchedule });
});

ipcMain.on('config:authenticate', async (e, data) => {
  await connect(data.companyId, data.apiKey);
});

ipcMain.on('dbConfig:setFolderPath', async (e, newFolderPath) => {
  if (newFolderPath) {
    folderPath = newFolderPath;
    dbConfig.setSetting('folder_path', newFolderPath);
  }
});

//previous schedule
ipcMain.on('sync:previousSchedule', async () => {
  let scheduleTrigger = await dbConfig.getSetting('sync_schedule');

  if (scheduleTrigger && folderPath) {
    mainWindow.webContents.send('system:log', 'Sync scheduled: ' + scheduleTrigger);
    let connection = await connect(companyId, apiKey);

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
  var config = {
    method: 'get',
    url: `${setting.baseUrl}/api/v2/tachofile/import/company/${company_id}/verify`,
    headers: {
      'API-KEY': api_key,
    },
  };

  let response = await axios(config);

  if (response) {
    apiKey = api_key;
    companyId = company_id;
    //update in db
    dbConfig.setSetting('api_key', apiKey);
    dbConfig.setSetting('company_id', companyId);
    dbConfig.refreshLastSync();
    mainWindow.webContents.send('config:success');
    return true;
  } else {
    console.log(error.message);
    mainWindow.webContents.send('config:error', error.response.data.message);
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
  //remove old task
  if (scheduleId) {
    try {
      clearInterval(scheduleId);
    } catch (error) {}
  }
  scheduleId = setInterval(
    () => {
      syncFolder(folderPath);
    },
    1000 * 60 * 60 * hour,
  );
}

ipcMain.on('sync:start', async () => {
  let connection = await connect(companyId, apiKey);
  if (connection) syncFolder(folderPath);
});

async function syncFolder(folder) {
  mainWindow.webContents.send('sync:updateFiles');
  await wait(2000);
  mainWindow.webContents.send('sync:changeStatusToProcessing');
  mainWindow.webContents.send('system:log', 'Processing sync..');
  fs.readdir(folder, (err, files) => {
    files.forEach((file) => {
      if (path.extname(file).toLowerCase() === '.ddd' || path.extname(file).toLowerCase() === '.esm') {
        file = path.join(folder, file);
        // sync this file
        var data = JSON.stringify({
          fileName: path.basename(file),
          downloadDate: '2021-04-22T08:33:00',
          fileBytes: fs.readFileSync(file, { encoding: 'base64' }),
        });

        console.log(apiKey);

        var config = {
          method: 'post',
          url: `${setting.baseUrl}/api/v2/tachofile/import/company/${companyId}`,
          headers: {
            'API-KEY': apiKey,
            'Content-Type': 'application/json',
          },
          data: data,
        };

        axios(config)
          .then(function (response) {
            //if job id then send event of change status to synced with file name
            if (response.data.jobId) {
              mainWindow.webContents.send('sync:updateStatus', {
                code: 200,
                message: 'Synced successfully',
                fileName: file,
                status: 'Synced',
              });
            } else {
              mainWindow.webContents.send('sync:updateStatus', {
                code: 401,
                message: 'Error occured by API',
                fileName: file,
                status: 'Not Synced',
              });
            }
          })
          .catch(function (error) {
            console.log(error);
          });

        // TODO Temporary fix for macos build. Logs either MacOS on develop or Win. Should be rethinking.
        if ((process.env.NODE_ENV === 'develop' && process.platform === 'darwin') || process.platform === 'win32') {
          const logFilePath = path.join(process.cwd(), 'log.txt');

          if (!fs.existsSync(logFilePath)) {
            fs.writeFileSync(logFilePath, '', { flag: 'w' });
          }

          fs.appendFileSync(logFilePath, `[${new Date().toLocaleString()}] (Success) ${path.basename(file)}\n`);
        }
      }
    });
  });
  mainWindow.webContents.send('system:update-last-sync', new Date().toLocaleString());
}

ipcMain.on('app:getVersion', () => {
  mainWindow.webContents.send('app:setVersion', app.getVersion());
});

function wait(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      console.log('Done waiting');
      resolve(ms);
    }, ms);
  });
}
