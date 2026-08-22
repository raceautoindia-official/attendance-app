/**
 * Upload a file to Google Drive as a service account. No dependencies.
 *
 * The database dumps already reach Drive through a service account
 * (drive-backup-service@...), so the credentials and the shared folder exist.
 * This reuses that arrangement rather than introducing a second one, and it
 * does so without adding googleapis to a production install: Node can sign the
 * RS256 assertion itself and the REST calls are three fetches.
 *
 * Configure with:
 *   GDRIVE_SERVICE_ACCOUNT_JSON=/path/to/service-account-key.json
 *   GDRIVE_TRACKING_FOLDER_ID=<folder id>
 */

const fs = require('fs');
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
// Narrowest scope that works: it grants access only to files this service
// account creates, which is all an uploader ever needs.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Reads the service-account key file, with a message worth acting on. */
function readKey(keyPath) {
  if (!keyPath) {
    throw new Error(
      'GDRIVE_SERVICE_ACCOUNT_JSON is not set. Point it at the same service-account ' +
      'key file the database backup already uses.',
    );
  }
  if (!fs.existsSync(keyPath)) {
    throw new Error('Service-account key not found at ' + keyPath);
  }
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  if (!key.client_email || !key.private_key) {
    throw new Error('That file is not a service-account key: no client_email / private_key.');
  }
  return key;
}

/** Exchanges a signed assertion for an access token. */
async function getAccessToken(keyPath) {
  const key = readKey(keyPath);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(
    crypto.createSign('RSA-SHA256').update(header + '.' + claims).sign(key.private_key),
  );
  const assertion = header + '.' + claims + '.' + signature;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error('Google refused the credentials: ' + (json.error_description || json.error || res.status));
  }
  return { token: json.access_token, email: key.client_email };
}

/**
 * Uploads one file and returns Drive's own record of it.
 *
 * The returned md5Checksum is the point: it is computed by GOOGLE from what
 * actually arrived, so comparing it to the local digest proves the upload is
 * complete rather than merely accepted. Nothing should be deleted on the
 * strength of a 200 alone.
 */
async function uploadFile({ token, folderId, filePath, name, mimeType = 'application/gzip' }) {
  const body = fs.readFileSync(filePath);
  const boundary = 'boundary' + crypto.randomBytes(16).toString('hex');
  const metadata = JSON.stringify({ name, parents: folderId ? [folderId] : undefined });

  const head = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metadata + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + mimeType + '\r\n\r\n',
  );
  const tail = Buffer.from('\r\n--' + boundary + '--');

  const res = await fetch(
    UPLOAD_URL + '?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,md5Checksum',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/related; boundary=' + boundary,
      },
      body: Buffer.concat([head, body, tail]),
    },
  );
  const json = await res.json();
  if (!res.ok || !json.id) {
    throw new Error('Drive rejected the upload: ' + (json.error ? json.error.message : res.status));
  }
  return json;
}

/** Reads Drive's record of a file back, to confirm it is really there. */
async function getFile(token, fileId) {
  const res = await fetch(
    FILES_URL + '/' + fileId + '?supportsAllDrives=true&fields=id,name,size,md5Checksum,trashed',
    { headers: { Authorization: 'Bearer ' + token } },
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error('Could not read the file back from Drive: ' +
                    (json.error ? json.error.message : res.status));
  }
  return json;
}

module.exports = { getAccessToken, uploadFile, getFile };
