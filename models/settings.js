const path = require('path');
const fs = require('fs');
const knex = require('knex');
const { app } = require('electron');

function getDbPath() {
  const appDir = path.join(__dirname, '..', 'app');
  const devDb = path.join(appDir, 'config_local.db');
  const templateProdDb = path.join(appDir, 'config.db');

  const isPackaged = app.isPackaged;

  if (!isPackaged) {
    return devDb;
  }

  try {
    const userDataDir = app.getPath('userData');
    const userDb = path.join(userDataDir, 'config.db');

    if (!fs.existsSync(userDb)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.copyFileSync(templateProdDb, userDb);
    }

    return userDb;
  } catch (err) {
    return templateProdDb;
  }
}

const dbPath = getDbPath();
console.log('[DB] Using:', dbPath);

const table = knex({
  client: 'sqlite3',
  connection: { filename: dbPath },
  useNullAsDefault: true,
});

// === API ===
async function getSetting(name) {
  const [data] = await table('settings').where({ name });
  return data ? data.value : null;
}

async function setSetting(name, value) {
  const existing = await table('settings').where({ name }).first();
  if (existing) {
    return table('settings').where({ name }).update({ value });
  } else {
    return table('settings').insert({ name, value });
  }
}

async function refreshLastSync() {
  return table('settings').where({ name: 'last_sync' }).update({ value: new Date().toLocaleString() });
}

module.exports = {
  getSetting,
  setSetting,
  refreshLastSync,
};
