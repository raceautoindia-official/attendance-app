// Does outgoing email actually work? Answers in one command, before the app
// depends on it.
//
//   node scripts/check-smtp.js                 # connect + authenticate only
//   node scripts/check-smtp.js you@example.com # ...and send a real test mail
//
// Reads SMTP_* from .env.local if present, else .env — the same values the app
// reads. Amazon SES fails in four ways that look identical from inside the app
// (all you see is "Failed to send email"), so every known failure is translated
// into the specific thing to change.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const nodemailer = require(path.join(ROOT, 'node_modules', 'nodemailer'));

const envFile = ['.env.local', '.env'].map(f => path.join(ROOT, f)).find(f => fs.existsSync(f));
if (!envFile) { console.error('No .env.local or .env found.'); process.exit(1); }
const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
console.log(`Reading ${path.basename(envFile)}\n`);

// SES API path first — region + IAM keys, no mail port involved.
const sesRegionEnv = env.SES_REGION;
const sesKey = env.SES_ACCESS_KEY_ID;
const sesSecret = env.SES_SECRET_ACCESS_KEY;
const usingSes = !!(sesRegionEnv && sesKey && sesSecret);

const host = env.SMTP_HOST;
const port = Number(env.SMTP_PORT) || 587;
const user = env.SMTP_USER;
const pass = env.SMTP_PASSWORD;
const from = env.SMTP_FROM;
const to = process.argv[2];

// --- What is even configured -------------------------------------------------
const missing = [];
if (!from) missing.push('SMTP_FROM');
if (!usingSes) {
  // Partial SES config is worth naming: two of three set means somebody meant
  // to use the API and mistyped a variable, and silently falling back to SMTP
  // would hide that.
  const sesPartial = [sesRegionEnv, sesKey, sesSecret].filter(Boolean).length;
  if (sesPartial > 0) {
    console.error('SES is half configured — set all three:');
    console.error(`  SES_REGION=${sesRegionEnv ? 'set' : 'MISSING'}`);
    console.error(`  SES_ACCESS_KEY_ID=${sesKey ? 'set' : 'MISSING'}`);
    console.error(`  SES_SECRET_ACCESS_KEY=${sesSecret ? 'set' : 'MISSING'}`);
    process.exit(1);
  }
  if (!host) missing.push('SMTP_HOST (or the three SES_* variables)');
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASSWORD');
}
if (missing.length) {
  console.error(`Not configured — missing: ${missing.join(', ')}`);
  process.exit(1);
}
if (!usingSes && /yourprovider|example\.|changeme/i.test(host)) {
  console.error(`SMTP_HOST is still a placeholder (${host}). Nothing has ever been sent.`);
  process.exit(1);
}

if (usingSes) {
  console.log('  mode  Amazon SES API (HTTPS, no mail port)');
  console.log(`  region ${sesRegionEnv}`);
  console.log(`  key   ${sesKey.slice(0, 8)}…`);
} else {
  console.log('  mode  SMTP');
  console.log(`  host  ${host}:${port}`);
  console.log(`  user  ${user}`);
}
console.log(`  from  ${from}`);

// A few checks that catch mistakes before the network does.
const sesRegion = !usingSes && host ? /^email-smtp\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host) : null;
if (sesRegion) {
  console.log(`  SES region: ${sesRegion[1]}`);
  // SES SMTP usernames look like an IAM access key ID (AKIA...), but they are
  // NOT one — they come from SES → SMTP settings → Create SMTP credentials.
  // A real IAM secret pasted as the password authenticates against nothing,
  // and the resulting error says only "535 Authentication Credentials
  // Invalid", which sounds like a typo rather than the wrong KIND of secret.
  if (pass.length === 40 && !/^BAC|^BP/.test(pass)) {
    console.log('  note  password is 40 chars — if this is an IAM secret key it will NOT work;');
    console.log('        SES SMTP passwords are generated in SES → SMTP settings.');
  }
}
console.log('');

const transporter = nodemailer.createTransport({
  host, port, secure: port === 465, auth: { user, pass },
});

function explain(err) {
  const text = `${err.name ?? ''} ${err.code ?? ''} ${err.responseCode ?? ''} ${err.message ?? ''}`;
  if (/InvalidClientTokenId|UnrecognizedClient|SignatureDoesNotMatch/i.test(text)) {
    return [
      'AWS rejected the credentials.',
      '  • Check SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY are an IAM key pair',
      '    (these ARE ordinary AWS keys — unlike the SMTP path, which needs',
      '    separate credentials generated in SES → SMTP settings).',
      '  • Check SES_REGION matches where the identity is verified.',
    ].join('\n');
  }
  if (/AccessDenied|not authorized/i.test(text)) {
    return 'The IAM user lacks permission. Attach ses:SendEmail (AmazonSESFullAccess covers it).';
  }
  if (/NotFound|does not exist/i.test(text) && /identity/i.test(text)) {
    return `The sender ${from} is not a verified identity in SES_REGION. Verify the address or the whole domain.`;
  }
  if (/EAUTH|535/.test(text)) {
    return [
      'The credentials were rejected.',
      '  • SES SMTP credentials are NOT your AWS access keys. Create them in',
      '    SES → SMTP settings → Create SMTP credentials (shown once).',
      '  • Check the host region matches where those credentials were created.',
    ].join('\n');
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) {
    return `The host "${host}" does not resolve. Check the region spelling: email-smtp.<region>.amazonaws.com`;
  }
  if (/ETIMEDOUT|ECONNREFUSED/.test(text)) {
    return [
      `Could not reach ${host}:${port}.`,
      '  • Many hosts block outbound 587 — try SMTP_PORT=465, or 2587 on SES.',
      '  • On AWS EC2, port 25 is blocked by default; 587/465 are not.',
    ].join('\n');
  }
  if (/Email address is not verified|MessageRejected/i.test(text)) {
    return [
      'SES rejected the sender or recipient.',
      `  • SMTP_FROM (${from}) must be a verified identity in SES.`,
      '  • While your account is in the SANDBOX, the RECIPIENT must also be',
      '    verified. Request production access in the SES console to send to',
      '    anyone — this is the step most often mistaken for a broken setup.',
    ].join('\n');
  }
  if (/Daily message quota|Throttling/i.test(text)) {
    return 'SES is throttling or the daily quota is spent — check the sending limits in the console.';
  }
  return null;
}

async function sendViaSes(recipient) {
  const { SESv2Client, SendEmailCommand } = require(
    path.join(ROOT, 'node_modules', '@aws-sdk', 'client-sesv2'));
  const client = new SESv2Client({
    region: sesRegionEnv,
    credentials: { accessKeyId: sesKey, secretAccessKey: sesSecret },
  });
  await client.send(new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [recipient] },
    Content: {
      Simple: {
        Subject: { Data: 'Attendance — SES test', Charset: 'UTF-8' },
        Body: { Html: { Data: '<p>If you are reading this, outgoing email works.</p>', Charset: 'UTF-8' } },
      },
    },
  }));
}

(async () => {
  if (usingSes) {
    // The SES API has no "log in and see" step — credentials are proven by a
    // real call. Without a recipient there is nothing safe to prove, so say
    // what to run rather than implying everything is fine.
    if (!to) {
      console.log('\nSES API configured. Credentials can only be proven by sending, so run:');
      console.log('  node scripts/check-smtp.js you@example.com');
      return;
    }
    try {
      process.stdout.write(`Sending a test message to ${to} via SES… `);
      await sendViaSes(to);
      console.log('accepted ✓');
      console.log('\nCheck the inbox (and spam). If it never arrives despite being');
      console.log('accepted, the address is likely unverified in an SES sandbox account.');
    } catch (err) {
      console.log('FAILED');
      console.error(`\n${err.message}`);
      const hint = explain(err);
      if (hint) console.error(`\n${hint}`);
      process.exit(1);
    }
    return;
  }

  try {
    process.stdout.write('Connecting and authenticating… ');
    await transporter.verify();
    console.log('OK ✓');
  } catch (err) {
    console.log('FAILED');
    console.error(`\n${err.message}`);
    const hint = explain(err);
    if (hint) console.error(`\n${hint}`);
    process.exit(1);
  }

  if (!to) {
    console.log('\nCredentials work. To prove delivery end to end, run:');
    console.log('  node scripts/check-smtp.js you@example.com');
    console.log('\nNote: authentication succeeding does NOT mean SES will accept the');
    console.log('recipient — in sandbox mode it refuses unverified addresses at send');
    console.log('time, not at login. Send a real test before trusting it.');
    return;
  }

  try {
    process.stdout.write(`Sending a test message to ${to}… `);
    const info = await transporter.sendMail({
      from, to,
      subject: 'Attendance — SMTP test',
      html: '<p>If you are reading this, outgoing email works.</p>'
        + '<p>Off-site clock-in alerts, phone-went-silent alerts and PIN reset links '
        + 'will now be delivered.</p>',
    });
    console.log('accepted ✓');
    console.log(`  message id: ${info.messageId}`);
    console.log('\nCheck the inbox (and spam). If it never arrives despite being');
    console.log('accepted, the address is likely unverified in an SES sandbox account.');
  } catch (err) {
    console.log('FAILED');
    console.error(`\n${err.message}`);
    const hint = explain(err);
    if (hint) console.error(`\n${hint}`);
    process.exit(1);
  }
})();
