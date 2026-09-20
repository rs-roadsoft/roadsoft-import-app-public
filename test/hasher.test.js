const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashFile, hashAll } = require('../sync/hasher');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-hasher-'));
}

test('hashFile is the md5 hex digest of the raw bytes — the value the server derives', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'abc.ddd');
  fs.writeFileSync(file, 'abc');

  assert.equal(await hashFile(file), '900150983cd24fb0d6963f7d28e17f72');
});

test('hashAll groups paths by content: two copies of one file are one entry with two paths', async () => {
  const dir = tempDir();
  const original = path.join(dir, 'M_1.DDD');
  const copy = path.join(dir, 'backup', 'M_1.DDD');
  const other = path.join(dir, 'M_2.DDD');
  fs.mkdirSync(path.dirname(copy));
  fs.writeFileSync(original, 'same bytes');
  fs.writeFileSync(copy, 'same bytes');
  fs.writeFileSync(other, 'different bytes');

  const entries = await hashAll([original, copy, other]);

  assert.equal(entries.length, 2);
  const grouped = entries.find((entry) => entry.paths.length === 2);
  assert.equal(grouped.fileName, 'M_1.DDD');
  assert.deepEqual(grouped.paths, [original, copy]);
  assert.equal(grouped.hash, await hashFile(original));
});

test('hashAll skips a file it cannot read, reports it, and hashes the rest', async () => {
  const dir = tempDir();
  const ok = path.join(dir, 'ok.ddd');
  fs.writeFileSync(ok, 'ok');
  const missing = path.join(dir, 'gone.ddd');
  const unreadable = [];

  const entries = await hashAll([missing, ok], (filePath, error) => unreadable.push({ filePath, code: error.code }));

  assert.deepEqual(unreadable, [{ filePath: missing, code: 'ENOENT' }]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].paths, [ok]);
});

test('hashAll names the upload after the shortest copy name, whatever the walk order', async () => {
  const dir = tempDir();
  const copy = path.join(dir, 'M_1 (1).DDD');
  const original = path.join(dir, 'sub', 'M_1.DDD');
  fs.mkdirSync(path.dirname(original));
  fs.writeFileSync(copy, 'same bytes');
  fs.writeFileSync(original, 'same bytes');

  const [entry] = await hashAll([copy, original]); // the copy is walked first

  assert.equal(entry.fileName, 'M_1.DDD');
  assert.deepEqual(entry.paths, [copy, original]);
});
