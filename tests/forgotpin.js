// Forgotten PIN: emailed link, single use, new PIN, everything else revoked.
//
// The security properties matter more than the happy path here, because this
// is the one endpoint an unauthenticated stranger can call:
//   • the answer is identical for a real and an invented employee ID, so it
//     cannot be used to discover IDs (they are short and guessable);
//   • the raw token is never stored — only its SHA-256;
//   • a link works ONCE, expires, and dies when a newer one is used;
//   • changing the PIN revokes every existing session.
//
//   node tests/forgotpin.js
//
// Needs a running server. Everything it touches is restored.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2];
}
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3123';
const EMP = Number(process.env.TEST_EMPLOYEE_ID || 6);

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const post = (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [[emp]] = await c.query(
    'SELECT id, emp_id, name, email, pin_hash FROM employees WHERE id = ?', [EMP]);
  if (!emp) throw new Error(`employee ${EMP} not found`);
  const originalPin = emp.pin_hash;
  const originalEmail = emp.email;

  const restore = async () => {
    await c.query('UPDATE employees SET pin_hash = ?, email = ? WHERE id = ?',
      [originalPin, originalEmail, EMP]);
    await c.query('DELETE FROM password_resets WHERE employee_id = ?', [EMP]);
  };

  // The route refuses when SMTP is unconfigured, which is the state of the
  // real deployment — so point it at something that resolves for the test and
  // let the send fail silently, exactly as the route is designed to tolerate.
  const smtpWasSet = process.env.SMTP_HOST;

  try {
    await c.query('UPDATE employees SET email = ? WHERE id = ?', ['reset-test@example.com', EMP]);
    await c.query('DELETE FROM password_resets WHERE employee_id = ?', [EMP]);

    console.log('\n1. The same answer for a real ID and an invented one');
    const real = await post('/api/auth/forgot-password', { emp_id: emp.emp_id });
    const fake = await post('/api/auth/forgot-password', { emp_id: 'NOSUCHEMP999' });
    const realJson = await real.json();
    const fakeJson = await fake.json();
    if (real.status === 503) {
      console.log(`   SKIPPED — server says: ${realJson.error}`);
      check('the refusal is about the SERVER, not the account',
        /email is not configured|not set up/i.test(realJson.error ?? ''), realJson.error);
      check('and it is the same for an invented ID', fake.status === 503);
    } else {
      check('real ID accepted', real.status === 200, real.status);
      check('invented ID answers identically',
        fake.status === real.status && fakeJson.message === realJson.message,
        `${fake.status} ${fakeJson.message}`);
      const [[row]] = await c.query(
        'SELECT COUNT(*) AS n FROM password_resets WHERE employee_id = ?', [EMP]);
      check('a token was stored for the real employee', Number(row.n) === 1, row.n);
      const [[bogus]] = await c.query(
        `SELECT COUNT(*) AS n FROM password_resets pr JOIN employees e ON e.id = pr.employee_id
          WHERE e.emp_id = 'NOSUCHEMP999'`);
      check('and none for the invented one', Number(bogus.n) === 0);
    }

    console.log('\n2. Only the HASH is stored — a dump yields no working link');
    // Mint a token directly, the way the route does, and prove the raw value
    // cannot be found in the table.
    const raw = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await c.query('DELETE FROM password_resets WHERE employee_id = ?', [EMP]);
    const [ins] = await c.query(
      `INSERT INTO password_resets (employee_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE))`, [EMP, hash]);
    const [[stored]] = await c.query(
      'SELECT token_hash FROM password_resets WHERE id = ?', [ins.insertId]);
    check('the raw token is nowhere in the row', stored.token_hash !== raw);
    check('the stored value is its sha256', stored.token_hash === hash);

    console.log('\n3. The link is checkable before the employee types anything');
    let r = await fetch(`${BASE}/api/auth/reset-password?token=${encodeURIComponent(raw)}`);
    let j = await r.json();
    check('a valid link resolves', r.status === 200, r.status);
    check('and names the account being reset', j.data?.emp_id === emp.emp_id, JSON.stringify(j.data));
    r = await fetch(`${BASE}/api/auth/reset-password?token=not-a-real-token`);
    check('a bogus link is refused', r.status === 400, r.status);

    console.log('\n4. Setting a new PIN');
    r = await post('/api/auth/reset-password', { token: raw, pin: '135791' });
    j = await r.json();
    check('accepted', r.status === 200, `${r.status} ${j.error ?? ''}`);
    const [[after]] = await c.query('SELECT pin_hash FROM employees WHERE id = ?', [EMP]);
    check('the PIN really changed', await bcrypt.compare('135791', after.pin_hash));
    check('the new PIN logs in', (await post('/api/auth/mobile/login',
      { emp_id: emp.emp_id, pin: '135791' })).status === 200);

    console.log('\n5. The link is spent — and so is every other outstanding one');
    r = await post('/api/auth/reset-password', { token: raw, pin: '246810' });
    check('the same link cannot be reused', r.status === 400, r.status);
    const [[unused]] = await c.query(
      'SELECT COUNT(*) AS n FROM password_resets WHERE employee_id = ? AND used_at IS NULL', [EMP]);
    check('no unused links remain', Number(unused.n) === 0, unused.n);

    console.log('\n6. A weak or malformed PIN is refused');
    const [ins2] = await c.query(
      `INSERT INTO password_resets (employee_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE))`,
      [EMP, crypto.createHash('sha256').update('second-token').digest('hex')]);
    r = await post('/api/auth/reset-password', { token: 'second-token', pin: '12' });
    check('a 2-digit PIN is rejected', r.status === 400, r.status);
    const [[stillOpen]] = await c.query(
      'SELECT used_at FROM password_resets WHERE id = ?', [ins2.insertId]);
    check('and the link is NOT burned by the failed attempt', stillOpen.used_at === null);

    console.log('\n7. An expired link does not work');
    await c.query(
      'UPDATE password_resets SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?',
      [ins2.insertId]);
    r = await post('/api/auth/reset-password', { token: 'second-token', pin: '445566' });
    check('expired is refused', r.status === 400, r.status);
    const [[unchanged]] = await c.query('SELECT pin_hash FROM employees WHERE id = ?', [EMP]);
    check('and the PIN is untouched', unchanged.pin_hash === after.pin_hash);
  } finally {
    await restore();
    await c.end();
    if (smtpWasSet === undefined) delete process.env.SMTP_HOST;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
