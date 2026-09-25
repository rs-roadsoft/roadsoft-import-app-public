const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyReceipt } = require('../sync/receipt');

const entry = (hash) => ({ hash, fileName: `${hash}.ddd`, size: 3, paths: [`/root/${hash}.ddd`] });

test('an entry the receipt lists with a fileId was stored; one without a fileId was refused at intake', () => {
  const batch = [entry('good'), entry('junk')];
  const receipt = {
    jobId: 'job-1',
    files: [
      { fileName: 'good.ddd', hash: 'good', fileId: 41, importId: 100 },
      { fileName: 'junk.ddd', hash: 'junk', importId: 101 },
    ],
  };

  const { stored, notStored } = classifyReceipt(batch, receipt);

  assert.deepEqual(
    stored.map((one) => one.hash),
    ['good'],
  );
  assert.deepEqual(
    notStored.map((one) => one.hash),
    ['junk'],
  );
});

test('an entry the receipt does not mention at all is not stored either', () => {
  const batch = [entry('a'), entry('b')];
  const receipt = { jobId: 'job-1', files: [{ fileName: 'a.ddd', hash: 'a', fileId: 1, importId: 2 }] };

  const { stored, notStored } = classifyReceipt(batch, receipt);

  assert.deepEqual(
    stored.map((one) => one.hash),
    ['a'],
  );
  assert.deepEqual(
    notStored.map((one) => one.hash),
    ['b'],
  );
});

test('a receipt without a files list (an older server) counts the whole batch as stored, as before', () => {
  const batch = [entry('a'), entry('b')];

  const { stored, notStored } = classifyReceipt(batch, { jobId: 'job-1' });

  assert.deepEqual(
    stored.map((one) => one.hash),
    ['a', 'b'],
  );
  assert.deepEqual(notStored, []);
});
