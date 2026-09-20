const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { moveTargetFor, removeEmptyParents } = require('../sync/move-target');

const root = path.resolve('/watched');
const archived = path.join(root, 'Archived');

test('a root-level file lands directly in the target folder', () => {
  const target = moveTargetFor(root, path.join(root, 'a.ddd'), archived);
  assert.deepEqual(target, { relFromRoot: 'a.ddd', destFilePath: path.join(archived, 'a.ddd') });
});

test('a nested file keeps its relative path under the target folder — the folder itself is never the target', () => {
  const file = path.join(root, 'vehicles', '23-BXK-5', 'M_x.DDD');
  const target = moveTargetFor(root, file, archived);
  assert.equal(target.relFromRoot, path.join('vehicles', '23-BXK-5', 'M_x.DDD'));
  assert.equal(target.destFilePath, path.join(archived, 'vehicles', '23-BXK-5', 'M_x.DDD'));
});

test('a path outside the root, or the root itself, is refused', () => {
  assert.equal(moveTargetFor(root, path.resolve('/elsewhere/a.ddd'), archived), null);
  assert.equal(moveTargetFor(root, path.join(root, '..', 'a.ddd'), archived), null);
  assert.equal(moveTargetFor(root, root, archived), null);
});

test('removeEmptyParents removes the emptied folder and its empty parents, stops at a non-empty one, never touches the root', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-move-'));

  const deep = path.join(tmpRoot, 'drivers', 'hupkes', 'old');
  fs.mkdirSync(deep, { recursive: true });
  await removeEmptyParents(deep, tmpRoot);
  assert.equal(fs.existsSync(path.join(tmpRoot, 'drivers')), false);
  assert.equal(fs.existsSync(tmpRoot), true);

  const leaf = path.join(tmpRoot, 'vehicles', 'AB-12-CD');
  fs.mkdirSync(leaf, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'vehicles', 'notes.txt'), 'kept');
  await removeEmptyParents(leaf, tmpRoot);
  assert.equal(fs.existsSync(leaf), false); // emptied leaf goes
  assert.equal(fs.existsSync(path.join(tmpRoot, 'vehicles')), true); // still holds notes.txt

  // outside the root: a real empty directory that must survive untouched
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-outside-'));
  const outsideLeaf = path.join(outside, 'empty');
  fs.mkdirSync(outsideLeaf);
  await removeEmptyParents(outsideLeaf, tmpRoot);
  assert.equal(fs.existsSync(outsideLeaf), true);
  assert.equal(fs.existsSync(outside), true);
});
