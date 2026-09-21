const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildUploadForm } = require('../sync/upload-form');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-form-'));
}

function entryFor(filePath) {
  const { size } = fs.statSync(filePath);
  return { hash: path.basename(filePath), fileName: path.basename(filePath), size, paths: [filePath] };
}

test('a zero-byte file does not break the synchronous length: the request still carries a Content-Length', () => {
  const dir = tempDir();
  const empty = path.join(dir, 'empty.ddd');
  const full = path.join(dir, 'full.ddd');
  fs.writeFileSync(empty, '');
  fs.writeFileSync(full, 'abc');

  const { form, sent } = buildUploadForm([entryFor(empty), entryFor(full)]);

  assert.equal(sent.length, 2);
  assert.equal(typeof form.getLengthSync(), 'number');
});

test('the form streams every entry at its full length', async () => {
  const dir = tempDir();
  const a = path.join(dir, 'a.ddd');
  const b = path.join(dir, 'b.ddd');
  fs.writeFileSync(a, 'x'.repeat(1000));
  fs.writeFileSync(b, '');

  const { form } = buildUploadForm([entryFor(a), entryFor(b)]);

  const declared = form.getLengthSync();
  const streamed = await new Promise((resolve, reject) => {
    let bytes = 0;
    form.on('data', (chunk) => (bytes += chunk.length));
    form.on('end', () => resolve(bytes));
    form.on('error', reject);
    form.resume();
  });
  assert.equal(streamed, declared);
});

test('an entry whose size changed since it was hashed is left out and reported, so a stale Content-Length is never declared', () => {
  const dir = tempDir();
  const stable = path.join(dir, 'stable.ddd');
  const growing = path.join(dir, 'growing.ddd');
  fs.writeFileSync(stable, 'abc');
  fs.writeFileSync(growing, 'abc');
  const entries = [entryFor(stable), entryFor(growing)];
  fs.appendFileSync(growing, 'more bytes after the hash');

  const { sent, changed } = buildUploadForm(entries);

  assert.deepEqual(
    sent.map((entry) => entry.fileName),
    ['stable.ddd'],
  );
  assert.deepEqual(
    changed.map((entry) => entry.fileName),
    ['growing.ddd'],
  );
});

test('an entry whose file vanished is reported as changed, not thrown', () => {
  const dir = tempDir();
  const gone = path.join(dir, 'gone.ddd');
  fs.writeFileSync(gone, 'abc');
  const entry = entryFor(gone);
  fs.unlinkSync(gone);

  const { form, sent, changed } = buildUploadForm([entry]);

  assert.equal(form, null);
  assert.deepEqual(sent, []);
  assert.deepEqual(changed, [entry]);
});

test('destroy() closes every stream the form opened, so a form that never went out does not leak file handles', () => {
  const dir = tempDir();
  const a = path.join(dir, 'a.ddd');
  fs.writeFileSync(a, 'abc');

  const { streams, destroy } = buildUploadForm([entryFor(a)]);

  assert.equal(streams.length, 1);
  assert.equal(streams[0].destroyed, false);
  destroy();
  assert.equal(streams[0].destroyed, true);
});
