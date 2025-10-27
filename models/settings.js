const knex = require('knex');
const config = require('../knexfile');
const table = knex(config.development);

async function getSetting(name) {
  let [data] = await table('settings').where({ name });
  return data.value;
}

async function setSetting(name, value) {
  return table('settings').where({ name: name }).update({ value: value });
}

async function refreshLastSync() {
  return table('settings').where({ name: 'last_sync' }).update({ value: new Date().toLocaleString() });
}

module.exports = {
  getSetting,
  setSetting,
  refreshLastSync,
};
