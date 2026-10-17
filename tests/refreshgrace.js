// A patch of bad signal must not log anybody out.
//
// The access token lasts 15 minutes, so a phone tracking all day renews its
// login every quarter of an hour, over mobile data. Two things made a renewal
// that merely did not get through into a logout:
//
//   1. The PHONE wiped the session on ANY failed refresh — a timeout, no
//      signal, a 502 while the server restarted — exactly as if the server had
//      refused it. From then on every location fix was rejected for want of a
//      token: tracking looked alive and uploaded nothing, and the next time the
//      employee opened the app it was at the login screen.
//
//   2. The SERVER deleted a refresh token the instant it was used. If the reply
//      carrying the new pair was lost on the way back, the phone was left
//      holding a token that no longer existed, and its next refresh WAS refused.
//
// Runs offline: the real refresh route against an in-memory refresh_tokens
// table, and the real phone client against a scripted network.
//
//   node tests/refreshgrace.js
const path = require('path');
const fs = require('fs');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const createJiti = require(path.join(ROOT, 'node_modules', 'jiti')).createJiti
  || require(path.join(ROOT, 'node_modules', 'jiti'));
const ts = require(path.join(ROOT, 'node_modules', 'typescript'));

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// ---------------------------------------------------------------------------
// An in-memory refresh_tokens table, with a clock the test can move.
// ---------------------------------------------------------------------------
let clockOffsetMs = 0;
const dbNow = () => Date.now() + clockOffsetMs;
const EMPLOYEE = { id: 7, emp_id: 'T007', name: 'Test', email: null, phone: null, role: 'employee', is_active: 1 };
let rows = [];
let nextId = 1;
const parseUtc = s => new Date(`${String(s).replace(' ', 'T')}Z`).getTime();

const stubDb = {
  async query(sql, params = []) {
    if (/FROM\s+refresh_tokens\s+rt/i.test(sql)) {
      const r = rows.find(x => x.token_hash === params[0] && x.expires_at > dbNow());
      return r ? [{ ...EMPLOYEE, token_id: r.id, expires_at: new Date(r.expires_at) }] : [];
    }
    if (/^\s*UPDATE\s+refresh_tokens/i.test(sql)) {
      const [graceSeconds, id] = params;
      const r = rows.find(x => x.id === id);
      if (r) r.expires_at = Math.min(r.expires_at, dbNow() + graceSeconds * 1000);
      return { affectedRows: r ? 1 : 0 };
    }
    if (/^\s*DELETE\s+FROM\s+refresh_tokens\s+WHERE\s+id/i.test(sql)) {
      rows = rows.filter(x => x.id !== params[0]);
      return { affectedRows: 1 };
    }
    if (/^\s*DELETE\s+FROM\s+refresh_tokens\s+WHERE\s+employee_id\s*=\s*\?\s+AND\s+expires_at/i.test(sql)) {
      rows = rows.filter(x => !(x.employee_id === params[0] && x.expires_at < dbNow()));
      return { affectedRows: 1 };
    }
    if (/^\s*INSERT\s+INTO\s+refresh_tokens/i.test(sql)) {
      rows.push({ id: nextId++, employee_id: params[0], token_hash: params[1], expires_at: parseUtc(params[2]) });
      return { insertId: nextId - 1 };
    }
    return [];
  },
  async queryOne(sql, params) {
    const r = await stubDb.query(sql, params);
    return Array.isArray(r) ? (r[0] ?? null) : null;
  },
  async insertAuditLog() {},
};
const stubPath = path.join(__dirname, 'stubs', '.refreshgrace-db.js');
fs.writeFileSync(stubPath, 'module.exports = global.__refreshGraceDb;');
global.__refreshGraceDb = stubDb;

const jiti = createJiti(__filename, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    '@/lib/db': stubPath,
    './db': stubPath,
    '@/lib/auth': path.join(ROOT, 'lib', 'auth.ts'),
    '@/lib/types': path.join(ROOT, 'lib', 'types.ts'),
    '@/lib/constants': path.join(ROOT, 'lib', 'constants.ts'),
  },
});

// ---------------------------------------------------------------------------
// The phone's client, transpiled as-is, over a scripted network.
// ---------------------------------------------------------------------------
function loadPhoneClient(store) {
  const cache = {};
  const SecureStore = {
    async getItemAsync(k) { return k in store ? store[k] : null; },
    async setItemAsync(k, v) { store[k] = v; },
    async deleteItemAsync(k) { delete store[k]; },
  };
  const mocks = {
    'react-native': { Platform: { OS: 'android' } },
    'expo-secure-store': SecureStore,
    '../config': { API_BASE_URL: 'https://server' },
  };
  const load = file => {
    if (cache[file]) return cache[file].exports;
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const m = new Module(file);
    cache[file] = m;
    m.require = id => mocks[id] ?? load(path.resolve(path.dirname(file), id) + '.ts');
    m._compile(js, file);
    return m.exports;
  };
  return load(path.join(ROOT, 'mobile', 'src', 'api', 'client.ts'));
}

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

(async () => {
  const auth = jiti(path.join(ROOT, 'lib', 'auth.ts'));
  const { POST } = jiti(path.join(ROOT, 'app', 'api', 'auth', 'mobile', 'refresh', 'route.ts'));
  const refresh = async token => {
    const res = await POST(new Request('http://localhost/api/auth/mobile/refresh', {
      method: 'POST', body: JSON.stringify({ refreshToken: token }),
    }));
    return { status: res.status, body: await res.json() };
  };
  const issue = () => {
    const token = auth.signRefreshToken({ id: EMPLOYEE.id });
    rows.push({ id: nextId++, employee_id: EMPLOYEE.id, token_hash: auth.generateRefreshTokenHash(token), expires_at: dbNow() + 7 * 86400_000 });
    return token;
  };

  console.log('\nServer: a refresh whose reply never arrived');
  const t0 = issue();
  let r = await refresh(t0);
  check('first refresh succeeds', r.status === 200, r.status);
  const t1 = r.body?.data?.refreshToken;
  // The phone never saw t1 — the reply was lost — so it tries again with t0.
  r = await refresh(t0);
  check('the same token works again inside the grace period', r.status === 200, `${r.status} ${r.body?.error ?? ''}`);
  r = await refresh(t1);
  check('and the pair it was given is valid too', r.status === 200, r.status);

  console.log('\nServer: the grace period ends');
  clockOffsetMs += 61 * 60_000;
  r = await refresh(t0);
  check('a retired token is refused once the grace period is over', r.status === 401, r.status);

  console.log('\nServer: a day of renewals does not grow the table');
  rows = []; clockOffsetMs = 0;
  let tok = issue();
  for (let i = 0; i < 40; i++) {                  // ten hours, every 15 minutes
    clockOffsetMs += 15 * 60_000;
    r = await refresh(tok);
    tok = r.body?.data?.refreshToken;
  }
  check('every renewal in the chain succeeded', r.status === 200 && !!tok, r.status);
  check('only the live token and those still in grace remain', rows.length <= 6, `${rows.length} rows`);

  console.log('\nPhone: a refresh that cannot get through keeps the session');
  for (const [label, refreshResponse] of [
    ['no signal', () => { throw new TypeError('Network request failed'); }],
    ['server restarting (502)', () => json(502, {})],
  ]) {
    const store = { access_token: 'expired', refresh_token: 'good' };
    const client = loadPhoneClient(store);
    global.fetch = async (url) => (String(url).endsWith('/api/auth/mobile/refresh')
      ? refreshResponse()
      : json(401, { success: false, error: 'expired' }));
    let err = null;
    try { await client.apiFetch('/api/live-tracking/ping', { method: 'POST', body: {} }); } catch (e) { err = e; }
    check(`${label}: the request fails as a network error, so it is retried`,
      err && !(err instanceof client.ApiError), err && `${err.constructor.name}: ${err.message}`);
    check(`${label}: the session is still there`, store.refresh_token === 'good' && store.access_token === 'expired',
      JSON.stringify(store));
  }

  console.log('\nPhone: the server refusing the refresh token still logs out');
  {
    const store = { access_token: 'expired', refresh_token: 'revoked' };
    const client = loadPhoneClient(store);
    global.fetch = async (url) => (String(url).endsWith('/api/auth/mobile/refresh')
      ? json(401, { success: false, error: 'Refresh token not found or expired' })
      : json(401, { success: false, error: 'expired' }));
    let err = null;
    try { await client.apiFetch('/api/attendance/today'); } catch (e) { err = e; }
    check('reported as a 401', err instanceof client.ApiError && err.status === 401, err && err.message);
    check('and the session is cleared', !store.refresh_token && !store.access_token, JSON.stringify(store));
  }

  console.log('\nPhone: a successful refresh retries the request');
  {
    const store = { access_token: 'expired', refresh_token: 'good' };
    const client = loadPhoneClient(store);
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/api/auth/mobile/refresh')) {
        return json(200, { success: true, data: { accessToken: 'fresh', refreshToken: 'next' } });
      }
      return init.headers.Authorization === 'Bearer fresh'
        ? json(200, { success: true, data: { ok: 1 } })
        : json(401, { success: false, error: 'expired' });
    };
    const data = await client.apiFetch('/api/attendance/today');
    check('the retried request succeeds', data?.ok === 1, JSON.stringify(data));
    check('with the new pair saved', store.access_token === 'fresh' && store.refresh_token === 'next', JSON.stringify(store));
  }

  fs.rmSync(stubPath, { force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  fs.rmSync(stubPath, { force: true });
  console.error('\nTest itself failed:', e);
  process.exit(1);
});
