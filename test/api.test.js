const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi, describeError, HASH_CHECK_BATCH_SIZE } = require('../sync/api');

function fakeRequest(answer) {
  const calls = [];
  const request = async (config) => {
    calls.push(config);
    return { data: answer(config) };
  };
  return { request, calls };
}

const options = {
  baseUrl: 'https://api.example',
  companyIdentifier: 'c0mpany-uuid',
  apiKey: 'k3y',
  headers: { 'Client-Type': 'roadsoft-uploader', 'App-Version': '9.9.9' },
};

test('hashCheck posts to the company hash-check endpoint with the API key and custom headers', async () => {
  const { request, calls } = fakeRequest(() => ({ results: [{ hash: 'aa', status: 'NOT_IMPORTED' }] }));
  const api = createApi({ ...options, request });

  const answers = await api.hashCheck(['aa']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'post');
  assert.equal(calls[0].url, 'https://api.example/api/v2/tachofile/import/company/c0mpany-uuid/hash-check');
  assert.equal(calls[0].headers['API-KEY'], 'k3y');
  assert.equal(calls[0].headers['Client-Type'], 'roadsoft-uploader');
  assert.deepEqual(calls[0].data, { hashes: ['aa'] });
  assert.equal(answers.get('aa'), 'NOT_IMPORTED');
});

test('hashCheck splits a large folder into requests of at most 1000 hashes and merges the answers', async () => {
  const hashes = Array.from({ length: 2500 }, (_, index) => `h${index}`);
  const { request, calls } = fakeRequest((config) => ({
    results: config.data.hashes.map((hash) => ({
      hash,
      status: hash === 'h1234' ? 'ALREADY_IMPORTED' : 'NOT_IMPORTED',
    })),
  }));
  const api = createApi({ ...options, request });

  const answers = await api.hashCheck(hashes);

  assert.deepEqual(
    calls.map((call) => call.data.hashes.length),
    [HASH_CHECK_BATCH_SIZE, HASH_CHECK_BATCH_SIZE, 500],
  );
  assert.equal(answers.size, 2500);
  assert.equal(answers.get('h1234'), 'ALREADY_IMPORTED');
  assert.equal(answers.get('h0'), 'NOT_IMPORTED');
});

test('hashCheck with no hashes makes no request', async () => {
  const { request, calls } = fakeRequest(() => ({ results: [] }));
  const api = createApi({ ...options, request });

  const answers = await api.hashCheck([]);

  assert.equal(calls.length, 0);
  assert.equal(answers.size, 0);
});

test('hashCheck lets a request failure propagate — the caller decides to postpone the run', async () => {
  const request = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  };
  const api = createApi({ ...options, request });

  await assert.rejects(api.hashCheck(['aa']), /ECONNREFUSED/);
});

test('describeError reads status, codeName and message when the server answered, and the message otherwise', () => {
  const httpError = { response: { status: 401, data: { codeName: 'invalid-api-key', message: 'Invalid API key' } } };
  assert.equal(describeError(httpError), 'HTTP 401 invalid-api-key Invalid API key');

  const networkError = new Error('connect ECONNREFUSED 127.0.0.1:443');
  assert.equal(describeError(networkError), 'connect ECONNREFUSED 127.0.0.1:443');
});
