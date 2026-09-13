/**
 * The three server calls the sync makes, and nothing else.
 *
 * Kept apart from the orchestration so `sync-folder.js` can be tested with a
 * fake of this module, and so the request shapes live in one place beside the
 * endpoints they talk to (`apps/be/src/modules/tachofile-import/tachofile-import.controller.ts`).
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

/** Files per bulk request — the server's own per-request cap. */
const BULK_BATCH_SIZE = 100;
/** Hashes per hash-check request — the server's `MAX_IMPORT_HASH_CHECK_BATCH`. */
const HASH_CHECK_BATCH_SIZE = 1000;
const QUEUE_FULL_CODE = 'FILE_UPLOAD_TOO_MANY_FILES_IN_QUEUE';
const QUEUE_FULL_RETRY_DELAY_MS = 30_000;
/**
 * Down from 20. Twenty waits of thirty seconds held one batch for ten minutes
 * while the rest of the folder queued behind it; five is two and a half
 * minutes, after which the batch is a transport failure the journal counts and
 * the sync moves on to the next batch.
 */
const QUEUE_FULL_MAX_RETRIES = 5;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createApi({ baseUrl, companyId, apiKey, headers }) {
  const authHeaders = { 'API-KEY': apiKey, ...headers };
  const companyUrl = `${baseUrl}/api/v2/tachofile/import/company/${companyId}`;

  /** `hash -> status` for every requested hash, over as many requests as needed. */
  async function hashCheck(hashes) {
    const results = new Map();
    for (let index = 0; index < hashes.length; index += HASH_CHECK_BATCH_SIZE) {
      const batch = hashes.slice(index, index + HASH_CHECK_BATCH_SIZE);
      const response = await axios.post(`${companyUrl}/hash-check`, { hashes: batch }, { headers: authHeaders });
      for (const result of response.data?.results ?? []) {
        results.set(result.hash, result.status);
      }
    }
    return results;
  }

  function buildForm(filePaths) {
    const form = new FormData();
    for (const filePath of filePaths) {
      form.append('files', fs.createReadStream(filePath), path.basename(filePath));
    }
    return form;
  }

  /**
   * One bulk request, retried only on the server's "queue full" answer. Any
   * other failure is thrown to the caller, which records it as a transport
   * failure for the batch. Returns `{ jobId, files: [{ fileName, importId, hash }] }`.
   */
  async function uploadBatch(filePaths, onRetry = () => {}) {
    for (let attempt = 1; ; attempt += 1) {
      // A fresh form each time: the streams are consumed by the attempt that sends them.
      const form = buildForm(filePaths);
      try {
        const response = await axios.post(`${companyUrl}/bulk`, form, {
          headers: { ...authHeaders, ...form.getHeaders() },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });
        return response.data;
      } catch (error) {
        const queueFull = error.response?.data?.codeName === QUEUE_FULL_CODE;
        if (!queueFull || attempt >= QUEUE_FULL_MAX_RETRIES) {
          throw error;
        }
        onRetry(attempt, QUEUE_FULL_MAX_RETRIES, QUEUE_FULL_RETRY_DELAY_MS);
        await delay(QUEUE_FULL_RETRY_DELAY_MS);
      }
    }
  }

  /** Every file the server holds under a job, with its status and its error. */
  async function getJobFiles(jobId) {
    const response = await axios.get(`${companyUrl}/job/${jobId}`, { headers: authHeaders });
    return Array.isArray(response.data) ? response.data : [];
  }

  return { hashCheck, uploadBatch, getJobFiles };
}

/** A readable one-liner for a failed request, for the journal and the log. */
function describeError(error) {
  const status = error.response?.status;
  const codeName = error.response?.data?.codeName;
  const message = error.response?.data?.message ?? error.message ?? String(error);
  return [status ? `HTTP ${status}` : null, codeName, message].filter(Boolean).join(' ');
}

module.exports = {
  BULK_BATCH_SIZE,
  HASH_CHECK_BATCH_SIZE,
  QUEUE_FULL_MAX_RETRIES,
  createApi,
  describeError,
};
