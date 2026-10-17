// Does the Firebase key for push notifications work? Answers in one command,
// before an employee waits for an approval that never arrives.
//
//   node scripts/check-push.js                    # the key named in .env / .env.local
//   node scripts/check-push.js path/to/key.json   # or a key file directly
//
// Signs in to Google with the key and asks Firebase to VALIDATE (not deliver)
// a message, so nothing reaches anybody's phone. Prints what to change for
// every failure it recognises. The private key itself is never printed.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));

function fromEnvFile() {
  const envFile = ['.env.local', '.env'].map(f => path.join(ROOT, f)).find(f => fs.existsSync(f));
  if (!envFile) return null;
  const env = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    console.log(`Key file from ${path.basename(envFile)}: ${env.FIREBASE_SERVICE_ACCOUNT_FILE}`);
    return fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8');
  }
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.log(`Key from FIREBASE_SERVICE_ACCOUNT_JSON in ${path.basename(envFile)}`);
    const v = env.FIREBASE_SERVICE_ACCOUNT_JSON;
    return v.startsWith('{') ? v : Buffer.from(v, 'base64').toString('utf8');
  }
  return null;
}

(async () => {
  let raw;
  try {
    raw = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : fromEnvFile();
  } catch (e) {
    console.error(`✗ Cannot read the key file: ${e.message}`);
    process.exit(1);
  }
  if (!raw) {
    console.error('✗ No key configured. Add to .env:\n    FIREBASE_SERVICE_ACCOUNT_FILE=/full/path/to/attendance-…-firebase-adminsdk-….json');
    process.exit(1);
  }
  let sa;
  try { sa = JSON.parse(raw); } catch { console.error('✗ The key file is not valid JSON.'); process.exit(1); }
  if (sa.type !== 'service_account' || !sa.private_key || !sa.client_email || !sa.project_id) {
    console.error('✗ Not a service-account key. Download it from Firebase: Project settings → Service accounts → Generate new private key.');
    process.exit(1);
  }
  console.log(`Project ${sa.project_id}, account ${sa.client_email}\n`);

  // 1. Sign in to Google with the key.
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    sa.private_key, { algorithm: 'RS256' });
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tokRes.ok || !tok.access_token) {
    console.error(`✗ Google refused the key (${tokRes.status}): ${tok.error_description ?? tok.error ?? 'no detail'}`);
    console.error('  The key was probably deleted or revoked in Firebase. Generate a new one and replace the file.');
    process.exit(1);
  }
  console.log('✓ Google accepted the key');

  // 2. Ask Firebase to validate a message to a made-up phone. Reaching the
  //    "that is not a real phone" answer proves everything before it works.
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ validate_only: true, message: { token: 'check-push-not-a-real-phone', notification: { title: 'check', body: 'check' } } }),
  });
  const body = await res.json().catch(() => ({}));
  const code = body.error?.details?.find(d => d.errorCode)?.errorCode ?? body.error?.status;
  if (res.ok || (res.status === 400 && /registration token/i.test(body.error?.message ?? ''))) {
    console.log('✓ Firebase Cloud Messaging is ready to send for this project');
    console.log('\nPush notifications will work once the push_tokens migration has run and phones on the');
    console.log('new build have signed in.');
    process.exit(0);
  }
  if (res.status === 403) {
    console.error(`✗ Firebase refused (${code}): ${body.error?.message ?? ''}`);
    console.error('  Enable "Firebase Cloud Messaging API" for the project: Firebase → Project settings →');
    console.error('  Cloud Messaging, or console.cloud.google.com → APIs & Services → Library.');
  } else if (res.status === 404) {
    console.error(`✗ Firebase does not know project "${sa.project_id}" — is this the key for the right project?`);
  } else {
    console.error(`✗ Unexpected answer from Firebase (${res.status} ${code}): ${body.error?.message ?? ''}`);
  }
  process.exit(1);
})().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
