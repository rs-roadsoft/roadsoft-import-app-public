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
/**
 * There is deliberately no "queue full, wait and retry" loop here. Earlier
 * builds retried up to twenty times on a `too-many-files-in-queue` answer; the
 * backend retired that code in RS-6709 — an upload over the company's intake
 * quota is staged and released later, never refused — so the loop could no
 * longer fire. Any refusal of a batch is what it looks like: a transport
 * failure the journal counts against the files, and the sync moves on.
 */
/**
 * Every request is bounded. Without a timeout a connection that never answers
 * — a filtered port, a half-open proxy — holds the run open indefinitely, and
 * because only one run may be in flight, every later scheduled trigger is then
 * refused as "already running": the app stops syncing until it is restarted,
 * silently. Found by pointing the sync at a dead port.
 *
 * The upload gets longer: a 100-file batch is tens of megabytes, and the
 * customer's uplink is what sets the pace (production measured ~0.65 MB/s).
 */
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

function createApi({ baseUrl, companyIdentifier, apiKey, headers }) {
  const authHeaders = { 'API-KEY': apiKey, ...headers };
  const companyUrl = `${baseUrl}/api/v2/tachofile/import/company/${companyIdentifier}`;

  /** `hash -> status` for every requested hash, over as many requests as needed. */
  async function hashCheck(hashes) {
    const results = new Map();
    for (let index = 0; index < hashes.length; index += HASH_CHECK_BATCH_SIZE) {
      const batch = hashes.slice(index, index + HASH_CHECK_BATCH_SIZE);
      const response = await axios.post(
        `${companyUrl}/hash-check`,
        { hashes: batch },
        { headers: authHeaders, timeout: REQUEST_TIMEOUT_MS },
      );
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
   * One bulk request. A failure is thrown to the caller, which records it as a
   * transport failure for the batch. Returns
   * `{ jobId, files: [{ fileName, importId, hash }] }`.
   */
  async function uploadBatch(filePaths) {
    const form = buildForm(filePaths);
    const response = await axios.post(`${companyUrl}/bulk`, form, {
      headers: { ...authHeaders, ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: UPLOAD_TIMEOUT_MS,
    });
    return response.data;
  }

  /** Every file the server holds under a job, with its status and its error. */
  async function getJobFiles(jobId) {
    const response = await axios.get(`${companyUrl}/job/${jobId}`, {
      headers: authHeaders,
      timeout: REQUEST_TIMEOUT_MS,
    });
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
  createApi,
  describeError,
};
