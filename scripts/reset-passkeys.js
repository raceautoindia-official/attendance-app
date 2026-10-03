#!/usr/bin/env node
/**
 * Clear stored passkeys so everyone re-enrols on a new hostname.
 *
 * WHY THIS EXISTS
 *
 * A passkey is bound to the Relying Party ID — the hostname. Move the site
 * from one host to another and every credential becomes unofferable: the
 * browser will not present it, because it was not created for this site.
 *
 * The login route decides what to ask for by looking in the DATABASE:
 *
 *     hasPasskeys ? requiresWebAuthn : requiresPasskeySetup
 *
 * After a move the rows are still there, so the server demands a passkey the
 * browser is not allowed to produce. Everyone is locked out, administrators
 * included — and the per-employee reset button is behind an admin login that
 * nobody can now reach.
 *
 * Deleting the rows puts every account back on the second branch: sign in with
 * employee ID and PIN, enrol a new passkey, carry on. PINs are untouched, so
 * nobody needs an administrator to let them back in.
 *
 * ONLY NEEDED IF the old WEBAUTHN_RP_ID was a subdomain. If it was already the
 * registrable parent (raceinnovations.in), credentials work across every
 * subdomain and this script has nothing to do — it will tell you so.
 *
 *   node scripts/reset-passkeys.js --dry-run   # who is affected; changes nothing
 *   node scripts/reset-passkeys.js --confirm   # actually deletes
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const confirmed = args.includes('--confirm');

if (!dryRun && !confirmed) {
  console.error(
    'Refusing to guess.\n\n' +
    '  node scripts/reset-passkeys.js --dry-run   see who is affected\n' +
    '  node scripts/reset-passkeys.js --confirm   delete the credentials\n',
  );
  process.exit(2);
}

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const rpId = process.env.WEBAUTHN_RP_ID ?? '(not set)';
  console.log(`WEBAUTHN_RP_ID is currently: ${rpId}`);
  if (rpId.split('.').length === 2) {
    console.log(
      'That is a registrable parent domain, so passkeys already work on every\n' +
      'subdomain and a rename does not invalidate them. You almost certainly do\n' +
      'not need this script. Continuing anyway only if you passed --confirm.\n',
    );
  }
  console.log('');

  const [rows] = await c.query(`
    SELECT e.id, e.emp_id, e.name, e.role, COUNT(p.id) AS passkeys
      FROM employees e
      JOIN passkeys p ON p.employee_id = e.id
     GROUP BY e.id, e.emp_id, e.name, e.role
     ORDER BY (e.role = 'super_admin') DESC, (e.role = 'manager') DESC, e.name ASC`);

  if (!rows.length) {
    console.log('No stored passkeys. Nothing to do.');
    await c.end();
    process.exit(0);
  }

  console.log(`${rows.length} account(s) hold a passkey:\n`);
  for (const r of rows) {
    console.log(
      `  ${String(r.emp_id).padEnd(10)} ${String(r.name).padEnd(24)} ` +
      `${String(r.role).padEnd(12)} ${r.passkeys} credential(s)`,
    );
  }

  const admins = rows.filter(r => r.role === 'super_admin').length;
  console.log(
    `\nIncluding ${admins} super admin(s). Each of these people signs in with their\n` +
    'employee ID and PIN afterwards and is taken straight to enrolling a new\n' +
    'passkey. PINs are NOT touched by this script.\n',
  );

  if (dryRun) {
    console.log('Dry run — nothing was deleted.');
    await c.end();
    process.exit(0);
  }

  const [res] = await c.query('DELETE FROM passkeys');
  console.log(`Deleted ${res.affectedRows} credential(s).`);
  console.log(
    '\nTell people: "the site has a new address, sign in with your employee ID\n' +
    'and PIN and set your fingerprint up once more."',
  );

  await c.end();
  process.exit(0);
})().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});
