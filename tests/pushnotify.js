// Notifications must reach a phone with the app CLOSED.
//
// Every notification used to be local: the phone polled the server and
// announced what it found. Open, that was every minute; closed, only when
// Android allowed a background task — hours later, or never on battery-strict
// phones. Approvals arrived "only when they opened the app".
//
// The server now pushes straight to Firebase Cloud Messaging (lib/push.ts) the
// moment an admin decides. This pins the parts that decide whether anybody is
// told:
//   - the message Firebase receives: the right phone, the app's channel, high
//     priority, data as strings (Firebase refuses anything else);
//   - a decision counts as delivered only when Firebase ACCEPTED it — so the
//     phone stops announcing only what really went out;
//   - dead addresses are dropped; a refused or missing key, or no network,
//     never throws into the approval that triggered the push;
//   - the phone announces a decision exactly once, whichever arrives first.
//
// Offline: real modules, a stub database, a scripted Google, and a key made up
// on the spot (never a real one).
//   node tests/pushnotify.js
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const createJiti = require(path.join(ROOT, 'node_modules', 'jiti')).createJiti
  || require(path.join(ROOT, 'node_modules', 'jiti'));
const ts = require(path.join(ROOT, 'node_modules', 'typescript'));

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

// ---------------------------------------------------------------------------
// Stub database: a push_tokens table and a log of statements.
// ---------------------------------------------------------------------------
const db = { hasTable: true, tokens: [] };
global.__pushTestDb = {
  async query(sql, params = []) {
    if (/INFORMATION_SCHEMA\.TABLES/i.test(sql)) return [{ n: db.hasTable ? 1 : 0 }];
    if (/^\s*SELECT\s+pt\.token/i.test(sql)) return db.tokens.filter(t => t.employee_id === params[0]);
    if (/^\s*INSERT INTO push_tokens/i.test(sql)) {
      const [employee_id, token, device_id, platform] = params;
      const row = db.tokens.find(t => t.token === token);
      if (row) Object.assign(row, { employee_id, device_id, platform });
      else db.tokens.push({ employee_id, token, device_id, platform });
      return { affectedRows: 1 };
    }
    if (/DELETE FROM push_tokens WHERE device_id = \? AND token <> \?/i.test(sql)) {
      db.tokens = db.tokens.filter(t => !(t.device_id === params[0] && t.token !== params[1])); return {};
    }
    if (/DELETE FROM push_tokens WHERE token = \?/i.test(sql)) {
      db.tokens = db.tokens.filter(t => t.token !== params[0]); return {};
    }
    return [];
  },
  async queryOne(sql, params) {
    const r = await global.__pushTestDb.query(sql, params);
    return Array.isArray(r) ? (r[0] ?? null) : null;
  },
  async insertAuditLog() {},
};
const stubPath = path.join(__dirname, 'stubs', '.pushnotify-db.js');
fs.writeFileSync(stubPath, 'module.exports = global.__pushTestDb;');

// A made-up service-account key.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_KEY = JSON.stringify({
  type: 'service_account', project_id: 'test-project',
  client_email: 'push@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

// Scripted Google: OAuth, then FCM. `phones` says what FCM answers per token.
const google = { oauthOk: true, oauthCalls: 0, phones: {}, sent: [], offline: false };
global.fetch = async (url, init) => {
  if (google.offline) throw new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com');
  if (url === 'https://oauth2.googleapis.com/token') {
    google.oauthCalls++;
    return google.oauthOk
      ? { ok: true, status: 200, json: async () => ({ access_token: 'access-1', expires_in: 3600 }) }
      : { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }) };
  }
  if (/fcm\.googleapis\.com\/v1\/projects\/test-project\/messages:send$/.test(url)) {
    const body = JSON.parse(init.body);
    google.sent.push({ auth: init.headers.Authorization, body });
    const answer = google.phones[body.message.token] ?? 'ok';
    if (answer === 'ok') return { ok: true, status: 200, json: async () => ({ name: 'projects/test-project/messages/1' }) };
    if (answer === 'uninstalled') {
      return { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }) };
    }
    return { ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Firebase Cloud Messaging API has not been used' } }) };
  }
  throw new Error('unexpected url ' + url);
};

const freshPush = () => createJiti(__filename, {
  interopDefault: true,
  moduleCache: false,
  alias: { '@/lib/db': stubPath },
})(path.join(ROOT, 'lib', 'push.ts'));

const T1 = 'cYx3aaaaaaaaaaaaaaaa:APA91bHaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const T2 = 'dZy4bbbbbbbbbbbbbbbb:APA91bHbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const msg = { title: 'Permission request approved ✅', body: 'x', channelId: 'permission-updates',
  data: { kind: 'permission_decision', id: 9, status: 'approved' } };

(async () => {
  console.log('\nNo table yet (migration not run)');
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = TEST_KEY;
  db.hasTable = false;
  let delivered = 0;
  await freshPush().pushToEmployee(7, msg, async () => { delivered++; });
  check('nothing is sent, nothing breaks', google.sent.length === 0 && delivered === 0);

  console.log('\nNo Firebase key on the server yet');
  db.hasTable = true;
  db.tokens = [{ employee_id: 7, token: T1 }];
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  await freshPush().pushToEmployee(7, msg, async () => { delivered++; });
  check('nothing is sent, nothing breaks', google.sent.length === 0 && delivered === 0);

  console.log('\nTwo phones: one alive, one uninstalled');
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = TEST_KEY;
  const push = freshPush();
  db.tokens = [{ employee_id: 7, token: T1 }, { employee_id: 7, token: T2 }];
  google.phones = { [T2]: 'uninstalled' };
  await push.pushToEmployee(7, msg, async () => { delivered++; });
  const m = google.sent[0]?.body?.message;
  check('one message per phone', google.sent.length === 2, `${google.sent.length}`);
  check('signed in with the key, then sent with the access token', google.oauthCalls === 1 && google.sent[0].auth === 'Bearer access-1');
  check('to the phone, with the title and text', m?.token === T1 && m.notification.title === msg.title);
  check('on the app\'s own channel, high priority', m?.android?.priority === 'HIGH' && m.android.notification.channel_id === 'permission-updates');
  check('data as strings — Firebase refuses anything else', m && Object.values(m.data).every(v => typeof v === 'string') && m.data.id === '9',
    JSON.stringify(m?.data));
  check('the uninstalled phone is forgotten at once', !db.tokens.some(t => t.token === T2), JSON.stringify(db.tokens));
  check('counted as delivered: Firebase accepted it for the live phone', delivered === 1, `${delivered}`);

  console.log('\nThe next push reuses the sign-in');
  await push.pushToEmployee(7, msg);
  check('no second sign-in within the hour', google.oauthCalls === 1, `${google.oauthCalls}`);

  console.log('\nFirebase refuses every phone (e.g. the messaging API switched off)');
  delivered = 0;
  google.phones = { [T1]: 'refused' };
  await push.pushToEmployee(7, msg, async () => { delivered++; });
  check('NOT counted as delivered — the phone must still announce it', delivered === 0);
  check('and the phone\'s address is kept — the fault is not the phone', db.tokens.some(t => t.token === T1));

  console.log('\nGoogle refuses the key (revoked)');
  google.phones = {};
  google.oauthOk = false;
  let threw = false;
  try { await freshPush().pushToEmployee(7, msg, async () => { delivered++; }); } catch { threw = true; }
  check('never throws into the approval that triggered it', !threw);
  check('not counted as delivered', delivered === 0);
  google.oauthOk = true;

  console.log('\nNo network');
  google.offline = true;
  threw = false;
  try { await freshPush().pushToEmployee(7, msg); } catch { threw = true; }
  check('never throws', !threw);
  google.offline = false;

  console.log('\nRegistering a phone');
  const jiti = createJiti(__filename, {
    interopDefault: true,
    moduleCache: false,
    alias: {
      '@/lib/db': stubPath,
      '@/lib/auth': path.join(__dirname, 'stubs', 'auth.js'),
      '@/lib/deviceBinding': path.join(ROOT, 'lib', 'deviceBinding.ts'),
      '@/lib/push': path.join(ROOT, 'lib', 'push.ts'),
      '@/lib/types': path.join(ROOT, 'lib', 'types.ts'),
    },
  });
  const { POST } = jiti(path.join(ROOT, 'app', 'api', 'push', 'register', 'route.ts'));
  const register = async (token, device) => {
    const res = await POST(new Request('http://localhost/api/push/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x', 'x-device-id': device },
      body: JSON.stringify({ token, platform: 'android' }),
    }));
    return { status: res.status, json: await res.json() };
  };
  db.tokens = [];
  let r = await register(T1, 'device-aaaa-0001');
  check('stored against the signed-in employee', r.status === 200 && db.tokens.length === 1 && db.tokens[0].device_id === 'device-aaaa-0001',
    `${r.status} ${JSON.stringify(db.tokens)}`);
  r = await register(T2, 'device-aaaa-0001');
  check('a new address from the same phone replaces the old one', db.tokens.length === 1 && db.tokens[0].token === T2,
    JSON.stringify(db.tokens));
  r = await register('not a token!', 'device-aaaa-0001');
  check('anything that is not a push address is refused', r.status === 400, r.status);

  // -------------------------------------------------------------------------
  console.log('\nThe phone announces each decision exactly once');
  const store = {};
  const announcedTitles = [];
  let tray = [];
  const mocks = {
    'expo-notifications': { async getPresentedNotificationsAsync() { return tray; } },
    '../storage/state': { async getState(k) { return store[k] ?? null; }, async setState(k, v) { store[k] = v; } },
    'react-native': { Platform: { OS: 'android' } },
    './setup': { CHANNELS: { permission: 'permission-updates' }, async notify(_c, title) { announcedTitles.push(title); return true; } },
  };
  const file = path.join(ROOT, 'mobile', 'src', 'notifications', 'permissionUpdates.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = new Module(file);
  mod.require = id => { if (id in mocks) return mocks[id]; throw new Error('unmocked ' + id); };
  mod._compile(js, file);
  const updates = mod.exports;
  const decision = (id, extra = {}) => ({ id, request_type: 'permission', permission_date: '2026-10-16',
    start_time: '10:00:00', end_time: '11:00:00', status: 'approved', review_notes: null, ...extra });

  await updates.notifyPermissionUpdates([decision(1)]);
  check('not pushed: the phone announces it itself (as before)', announcedTitles.length === 1);
  await updates.notifyPermissionUpdates([decision(1)]);
  check('and never twice', announcedTitles.length === 1);
  await updates.notifyPermissionUpdates([decision(2, { pushed: true })]);
  check('confirmed pushed: not announced again', announcedTitles.length === 1);
  // Firebase hands data over as strings: the push says id "3", the server 3.
  tray = [{ request: { content: { data: { kind: 'permission_decision', id: '3' } } } }];
  await updates.notifyPermissionUpdates([decision(3)]);
  check('pushed and still in the tray: not announced again', announcedTitles.length === 1);
  tray = [];
  await updates.markDecisionAnnounced({ kind: 'permission_decision', id: '4' });
  await updates.notifyPermissionUpdates([decision(4)]);
  check('pushed while the app was open: not announced again', announcedTitles.length === 1);
  await updates.notifyPermissionUpdates([decision(1), decision(2, { pushed: true }), decision(3), decision(4)]);
  check('none of them come back on later polls', announcedTitles.length === 1, announcedTitles.join(' | '));

  fs.rmSync(stubPath, { force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  fs.rmSync(stubPath, { force: true });
  console.error('\nTest itself failed:', e);
  process.exit(1);
});
