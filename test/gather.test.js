const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gatherSyncFiles, DIRS } = require('../sync/gather');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-gather-'));
  const write = (relative) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, relative);
    return full;
  };
  return { root, write };
}

test('collects .ddd and .esm from the root and nested folders, case-insensitively', () => {
  const { root, write } = makeTree();
  const a = write('a.ddd');
  const b = write('vehicles/23-BXK-5/b.DDD');
  const c = write('drivers/1/c.esm');
  write('readme.txt');
  write('vehicles/notes.pdf');

  const found = gatherSyncFiles(root).sort();
  assert.deepEqual(found, [a, b, c].sort());
});

test('skips top-level Archived and Failed, but not a nested folder with the same name', () => {
  const { root, write } = makeTree();
  write(`${DIRS.ARCHIVED}/old.ddd`);
  write(`${DIRS.FAILED}/bad.ddd`);
  write('failed/lower.ddd'); // case-insensitive match at the top level: skipped too
  const nested = write(`vehicles/${DIRS.ARCHIVED}/keep.ddd`);

  assert.deepEqual(gatherSyncFiles(root), [nested]);
});

test('stops below the depth limit', () => {
  const { root, write } = makeTree();
  const shallow = write('1/2/3/4/5/6/7/8/9/10/ok.ddd'); // depth 10: collected
  write('1/2/3/4/5/6/7/8/9/10/11/too-deep.ddd'); // depth 11: not collected

  assert.deepEqual(gatherSyncFiles(root), [shallow]);
});
