const electron = require('electron');
const { ipcRenderer, shell } = electron;
const { dialog } = require('@electron/remote');
const fs = require('fs');
const path = require('path');
let connected = false;

//data table settings
var filesDataTable = $('#dtBasicExample').DataTable({
  columnDefs: [{ width: '10%', targets: 0 }],
  ordering: false,
});
$('.dataTables_length').addClass('bs-select');

addLog('Welcome to RoadSoft File Sync Utility');

//initial settings
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

//check for schedule
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
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!companyId || !apiKey) {
    addLog('Please fill company identifier and api key.');
    return;
  }

  if (!uuidRegex.test(companyId)) {
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

$('#select-folder').on('click', async function () {
  var path = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (!path.canceled) {
    let folderPath = path.filePaths[0];
    $('#folder-path').text(folderPath);
    getFilesFromFolder(folderPath);
    ipcRenderer.send('dbConfig:setFolderPath', folderPath);
  }
});

function getFilesFromFolder(folderPath) {
  filesDataTable.clear().draw();
  //create archieved or failed folder
  if (!fs.existsSync(path.join(folderPath, 'Archived'))) {
    fs.mkdirSync(path.join(folderPath, 'Archived'));
  }
  if (!fs.existsSync(path.join(folderPath, 'Failed'))) {
    fs.mkdirSync(path.join(folderPath, 'Failed'));
  }

  //read all the files
  fs.readdir(folderPath, (err, files) => {
    files.forEach((file) => {
      if (path.extname(file).toLowerCase() === '.ddd' || path.extname(file).toLowerCase() === '.esm') {
        addNewFile(file);
      }
    });
  });
}

function addNewFile(filename) {
  filesDataTable.row.add(['_', `<i class="fa fa-file-text"></i>&nbsp;&nbsp; ${filename}`, 'Not Synced']).draw(false);
}

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

function changeStatusToProcessing() {
  filesDataTable.rows((idx, data, node) => {
    if (data[2] === 'Not Synced') {
      filesDataTable
        .row(idx)
        .data([data[0], data[1], '<i class="fa fa-refresh fa-spin"></i>&nbsp;&nbsp; Syncronizing'])
        .draw();
    }
  });
}

//receive file status
ipcRenderer.on('sync:updateStatus', function (event, data) {
  let filename = path.basename(data.fileName);

  let i = filesDataTable
    .rows()
    .indexes()
    .filter(function (value, index) {
      return filesDataTable.row(value).data()[1].includes(` ${filename}`);
    });

  //move file to archieved or failed
  if (fs.existsSync(data.fileName)) {
    //move to archieved
    fs.rename(data.fileName, path.join(path.dirname(data.fileName), 'Archived', filename), (err) => {
      if (err) addLog(`Error moving file: ${err?.message || err}`);
    });
  }

  filesDataTable
    .row(i[0])
    .data(['1', `<i class="fa fa-file-text"></i>&nbsp;&nbsp; ${filename}`, data.status])
    .draw();
});

ipcRenderer.on('system:log', function (event, data) {
  addLog(data);
});

ipcRenderer.on('system:update-last-sync', function (event, data) {
  $('#last-sync').text(data);
});

$('#folder-path').on('click', function (e) {
  e.preventDefault();

  let folder = $('#folder-path').text();

  if (folder) {
    shell.openPath(folder);
  }
});

$('#open-log').on('click', function (e) {
  e.preventDefault();

  let logFile = $('#open-log').text();

  if (logFile) {
    shell.openPath('log.txt');
  }
});

function addLog(msg) {
  $('#logArea').append(msg + '\n');
  $('#logArea').scrollTop($('#logArea')[0].scrollHeight);
}

ipcRenderer.send('app:getVersion');

ipcRenderer.on('app:setVersion', (e, version) => {
  $('title').text(`${$('title').text()} v${version}`);
});
