const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const knex = require('knex');
const journal = require('../models/journal');
const hasher = require('../sync/hasher');

let db;
let dir;

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await journal.ensureSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs7317-hasher-'));
});

afterEach(async () => {
  await db.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name, bytes) => {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
};

test('hashFile is the md5 hex of the raw bytes — the same value the server derives', async () => {
  const bytes = Buffer.from('not a real card, but stable bytes');
  const filePath = write('a.ddd', bytes);
  assert.equal(await hasher.hashFile(filePath), createHash('md5').update(bytes).digest('hex'));
});

test('hashWithCache hashes once, then serves the cache while size and mtime are unchanged', async () => {
  const filePath = write('a.ddd', Buffer.from('bytes'));
  const first = await hasher.hashWithCache(db, filePath);
  const cached = await journal.fileCacheGet(db, filePath);
  assert.equal(cached.hash, first);

  // Poison the cache to prove the second call reads it rather than the file.
  await journal.fileCacheSet(db, { ...cached, hash: 'from-cache' });
  assert.equal(await hasher.hashWithCache(db, filePath), 'from-cache');
});

test('hashWithCache re-hashes when the file changes', async () => {
  const filePath = write('a.ddd', Buffer.from('v1'));
  const first = await hasher.hashWithCache(db, filePath);

  // A different size is enough; mtime alone can tie within the same ms.
  fs.writeFileSync(filePath, Buffer.from('v2 is longer'));
  const second = await hasher.hashWithCache(db, filePath);

  assert.notEqual(second, first);
  assert.equal(second, createHash('md5').update(Buffer.from('v2 is longer')).digest('hex'));
});

test('hashAll groups paths by content — two copies of one file are one entry with two paths', async () => {
  const bytes = Buffer.from('same bytes twice');
  const one = write('one.ddd', bytes);
  const two = write('copy-of-one.ddd', bytes);
  const other = write('other.ddd', Buffer.from('different'));

  const entries = await hasher.hashAll(db, [one, two, other]);

  assert.equal(entries.length, 2);
  const same = entries.find((entry) => entry.paths.length === 2);
  assert.deepEqual(same.paths, [one, two]);
  assert.equal(same.fileName, 'one.ddd');
});
