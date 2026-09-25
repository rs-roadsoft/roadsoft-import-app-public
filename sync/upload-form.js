/**
 * The multipart form for one batch, built right before the request goes out
 * (and again before every retry).
 *
 * - Sizes are measured again here. The size was taken when the file was hashed,
 *   minutes earlier on a large folder; a file that grew, shrank or vanished since
 *   is left out (`changed`) and offered again next run — its md5 is stale and a
 *   wrong declared length would cut the upload short or stall it.
 * - A zero-byte file goes in as an empty Buffer, not a stream: form-data reads
 *   `knownLength: 0` as "unknown", and `getLengthSync()` then throws before any
 *   request is made — every file in the batch stayed unsent, every run, and the
 *   streams already opened were never closed. The empty part still reaches the
 *   server, which gives the verdict (rejected at intake) like for any other file.
 * - `destroy()` closes the streams of a form that never went out.
 */
const fs = require('fs');
const FormData = require('form-data');

function buildUploadForm(entries) {
  const form = new FormData();
  const sent = [];
  const changed = [];
  const streams = [];
  for (const entry of entries) {
    let size = null;
    try {
      ({ size } = fs.statSync(entry.paths[0]));
    } catch (error) {
      // gone or unreadable: same treatment as a file that changed
    }
    if (size !== entry.size) {
      changed.push(entry);
      continue;
    }
    if (entry.size === 0) {
      form.append('files', Buffer.alloc(0), { filename: entry.fileName, knownLength: 0 });
    } else {
      const stream = fs.createReadStream(entry.paths[0]);
      streams.push(stream);
      form.append('files', stream, { filename: entry.fileName, knownLength: entry.size });
    }
    sent.push(entry);
  }
  const destroy = () => {
    for (const stream of streams) stream.destroy();
  };
  return { form: sent.length ? form : null, sent, changed, streams, destroy };
}

module.exports = { buildUploadForm };
