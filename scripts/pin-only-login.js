#!/usr/bin/env node
/**
 * Sign in with employee ID and PIN. No passkey.
 *
 * WHY THIS EXISTS
 *
 * The login route decides what to ask for in this order:
 *
 *     if (hasPasskeys)  -> demand WebAuthn        <- checked FIRST
 *     if (hasExemption) -> issue tokens on the PIN
 *     otherwise         -> demand passkey ENROLMENT
 *
 * Two consequences people keep running into:
 *
 *   1. Granting a PIN exemption to somebody who already has a passkey does
 *      NOTHING. The first branch wins and they still get the browser's
 *      "Choose a passkey" dialog, which on a desktop they often cannot answer
 *      — the credential lives on a phone they no longer have, or was enrolled
 *      against a hostname that has since changed.
 *   2. Deleting their passkeys alone is not enough either: they land on the
 *      third branch and are told to enrol a new one.
 *
 * Only doing BOTH — clear the passkeys and grant the exemption — produces
 * "type your ID and PIN, press Sign in, you are in".
 *
 * scripts/reset-passkeys.js does the clearing, but it reads .env.local only,
 * and production has no .env.local — it finds no database and does nothing.
 * This reads .env the way the app does.
 *
 * WHAT IT COSTS, SAID PLAINLY
 *
 * The passkey is the second factor. Afterwards a 6-digit PIN is the whole of
 * the authentication, for the app as well as the browser, because there is one
 * login route. That may well be the right trade for a shop floor. It should be
 * a decision, not a surprise.
 *
 * The exemption holds until they enrol a passkey, because hasPasskeys is
 * checked first. Tell people to skip the enrolment prompt, or they quietly go
 * back to needing one.
 *
 *   node scripts/pin-only-login.js --emp=RACE013              # dry run
 *   node scripts/pin-only-login.js --emp=RACE013 --confirm
 *   node scripts/pin-only-login.js --all --confirm            # every active employee
 *   node scripts/pin-only-login.js --emp=RACE013 --undo --confirm
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
require('./lib/env').loadEnv(ROOT);

const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const confirmed = has('--confirm');
const all = has('--all');
const undo = has('--undo');
const emp = valueOf('emp', '');
const byArg = valueOf('by', '');
const reason = valueOf('reason', 'PIN-only login authorised by the administrator');

if ((!emp && !all) || has('--help') || has('-h')) {
  console.log(
    'Sign in with employee ID and PIN, with no passkey.\n\n' +
    '  node scripts/pin-only-login.js --emp=RACE013             dry run\n' +
    '  node scripts/pin-only-login.js --emp=RACE013 --confirm   do it\n' +
    '  node scripts/pin-only-login.js --all --confirm           every active employee\n\n' +
    'Options:\n' +
    '  --emp=RACE013   employee code, or part of their name\n' +
    '  --all           every active employee (use deliberately)\n' +
    '  --undo          revoke the exemption again; passkeys cannot be restored,\n' +
    '                  the employee simply enrols a new one at next sign-in\n' +
    '  --by=RACE013    who authorised it; defaults to a super_admin\n' +
    '  --reason="..."  recorded in the audit entry\n' +
    '  --confirm       actually write\n',
  );
  process.exit(emp || all ? 0 : 1);
}

async function main() {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: '+00:00',
  });

  try {
    // Who is being changed.
    let people;
    if (all) {
      [people] = await c.query(
        'SELECT id, emp_id, name FROM employees WHERE is_active = TRUE ORDER BY emp_id');
    } else {
      [people] = await c.query(
        `SELECT id, emp_id, name FROM employees
          WHERE is_active = TRUE AND (emp_id = ? OR name LIKE CONCAT('%', ?, '%'))
          ORDER BY (emp_id = ?) DESC, name ASC LIMIT 10`,
        [emp, emp, emp]);
      if (people.length === 0) throw new Error(`No active employee matching "${emp}".`);
      if (people.length > 1) {
        throw new Error(
          `"${emp}" matches ${people.length} people:\n` +
          people.map((p) => `    ${p.emp_id}  ${p.name}`).join('\n') +
          '\n\n  Run it again with the code of the one you mean. Nothing written.');
      }
    }

    // Who authorised it. granted_by is NOT NULL, so this has to resolve.
    let by = null;
    if (byArg) {
      const [[a]] = await c.query(
        'SELECT id, emp_id FROM employees WHERE emp_id = ? LIMIT 1', [byArg]);
      if (!a) throw new Error(`No employee with emp_id "${byArg}" for --by.`);
      by = a;
    } else {
      const [[a]] = await c.query(
        `SELECT id, emp_id FROM employees
          WHERE role = 'super_admin' AND is_active = TRUE ORDER BY id LIMIT 1`);
      if (!a) throw new Error('No super_admin found to record as the authoriser; pass --by=.');
      by = a;
    }

    // Current state, per person, so the dry run shows what actually changes.
    const ids = people.map((p) => p.id);
    const [pk] = await c.query(
      `SELECT employee_id, COUNT(*) AS n FROM passkeys
        WHERE employee_id IN (${ids.map(() => '?').join(',')}) GROUP BY employee_id`, ids);
    const [ex] = await c.query(
      `SELECT employee_id FROM passkey_exemptions
        WHERE is_active = TRUE AND employee_id IN (${ids.map(() => '?').join(',')})`, ids);
    const passkeysOf = new Map(pk.map((r) => [r.employee_id, Number(r.n)]));
    const exemptOf = new Set(ex.map((r) => r.employee_id));

    console.log(undo ? 'Revoking PIN-only login:\n' : 'Granting PIN-only login:\n');
    console.table(people.map((p) => ({
      emp_id: p.emp_id,
      name: p.name,
      passkeys_now: passkeysOf.get(p.id) ?? 0,
      exempt_now: exemptOf.has(p.id) ? 'yes' : 'no',
      after: undo
        ? 'passkey required again at next sign-in'
        : 'ID + PIN only',
    })));
    console.log(`Authorised by: ${by.emp_id}`);
    console.log(`Reason:        ${reason}\n`);

    if (!confirmed) {
      console.log('DRY RUN — nothing written. Add --confirm to write it.');
      return;
    }

    let changed = 0;
    for (const p of people) {
      if (undo) {
        await c.query(
          'UPDATE passkey_exemptions SET is_active = FALSE WHERE employee_id = ? AND is_active = TRUE',
          [p.id]);
      } else {
        // BOTH, or it does not work. See the note at the top of this file.
        await c.query('DELETE FROM passkeys WHERE employee_id = ?', [p.id]);
        await c.query(
          'UPDATE passkey_exemptions SET is_active = FALSE WHERE employee_id = ? AND is_active = TRUE',
          [p.id]);
        await c.query(
          'INSERT INTO passkey_exemptions (employee_id, granted_by, reason) VALUES (?, ?, ?)',
          [p.id, by.id, reason]);
      }
      await c.query(
        `INSERT INTO audit_log (action, entity, entity_id, performed_by, details, created_at)
         VALUES (?, 'employees', ?, ?, ?, UTC_TIMESTAMP())`,
        [undo ? 'passkey_exemption_revoked' : 'pin_only_login_granted',
          p.id, by.id, JSON.stringify({
            emp_id: p.emp_id,
            passkeys_cleared: undo ? 0 : (passkeysOf.get(p.id) ?? 0),
            reason,
            authorised_by: by.emp_id,
            granted_by_tool: 'scripts/pin-only-login.js',
          })]);
      changed++;
    }

    console.log(`Done — ${changed} ${changed === 1 ? 'employee' : 'employees'}, audited.`);
    if (!undo) {
      console.log('They sign in with employee ID and PIN. Tell them to SKIP any prompt');
      console.log('to set up a passkey — enrolling one puts them back to needing it.');
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`\n${e.message}\n`);
  process.exit(1);
});
