/**
 * The one server call this build adds: `hash-check`, the question "which of
 * these files do you already have?" asked before anything is uploaded.
 *
 * The request is injectable so the tests run against a fake; the app passes
 * nothing and gets axios. Deliberately no timeout — the product owner's call,
 * and consistent with every other request the app makes.
 */
const axios = require('axios');

/** Hashes per hash-check request — the server's per-request cap. */
const HASH_CHECK_BATCH_SIZE = 1000;

function createApi({ baseUrl, companyIdentifier, apiKey, headers, request = axios }) {
  const authHeaders = { 'API-KEY': apiKey, ...headers };
  const companyUrl = `${baseUrl}/api/v2/tachofile/import/company/${companyIdentifier}`;

  /**
   * `hash -> status` for every requested hash, over as many requests as needed.
   * Statuses: ALREADY_IMPORTED, PERMANENTLY_FAILED, NOT_IMPORTED. A request
   * failure is thrown to the caller: without the answer nothing may be sent.
   */
  async function hashCheck(hashes) {
    const results = new Map();
    for (let index = 0; index < hashes.length; index += HASH_CHECK_BATCH_SIZE) {
      const batch = hashes.slice(index, index + HASH_CHECK_BATCH_SIZE);
      const response = await request({
        method: 'post',
        url: `${companyUrl}/hash-check`,
        headers: authHeaders,
        data: { hashes: batch },
      });
      for (const result of response.data?.results ?? []) {
        results.set(result.hash, result.status);
      }
    }
    return results;
  }

  return { hashCheck };
}

/** A readable one-liner for a failed request, for the UI log and main.log. */
function describeError(error) {
  const status = error?.response?.status;
  const codeName = error?.response?.data?.codeName;
  const message = error?.response?.data?.message ?? error?.message ?? String(error);
  return [status ? `HTTP ${status}` : null, codeName, message].filter(Boolean).join(' ');
}

module.exports = { HASH_CHECK_BATCH_SIZE, createApi, describeError };
