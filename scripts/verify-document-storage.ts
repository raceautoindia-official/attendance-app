/**
 * scripts/verify-document-storage.ts — where employee documents live.
 *
 *   npx tsx --env-file=.env.local scripts/verify-document-storage.ts
 *
 * Runs against whatever is configured. With no bucket it proves the database
 * fallback is intact — which is the state production is in right now, so this
 * is the path that matters until a bucket exists. With a bucket set it proves
 * the S3 path end to end, including the two checks that stop a bad upload being
 * filed.
 *
 * Touches only the local database. Any object it writes to S3 it removes.
 */

import { NextRequest } from 'next/server';
import { POST as uploadRoute } from '../app/api/employees/[id]/documents/route';
import { GET as statusRoute, POST as presignRoute } from '../app/api/employees/[id]/documents/presign/route';
import { GET as downloadRoute, DELETE as deleteRoute } from '../app/api/employees/[id]/documents/[docId]/route';
import {
  isS3Configured, storageStatus, buildKey, keyPrefixFor, headObject, deleteObject,
} from '../lib/documentStorage';
import { DOCUMENT_TYPES } from '../lib/employeeDetails';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// A one-pixel PNG, so the upload is a real file of a supported type.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Name the cause of a failed PUT instead of listing suspects.
 *
 * S3 answers a rejected upload with an XML body carrying a <Code>, and that
 * code distinguishes the three failures that look identical from the browser:
 * a key AWS has never heard of, a key that exists but may not write here, and
 * a signature that no longer matches the request. Status 0 with no body is the
 * fourth: the request never left the browser, which is what CORS looks like.
 *
 * The body is NOT echoed. An InvalidAccessKeyId response quotes the access key
 * back in an <AWSAccessKeyId> element, so only the <Code> is read out.
 */
function diagnoseUploadFailure(body: string, status: number): string {
  // RegExp built from a string so no escaping is needed for the closing tag.
  const code = new RegExp('<Code>([^<]+)</Code>').exec(body)?.[1] ?? '';
  const explain: Record<string, string> = {
    InvalidAccessKeyId:
      'S3_ACCESS_KEY_ID does not exist in AWS at all — deleted, or never created.'
      + ' Not a permissions problem: create a key in IAM and put it in .env.local.',
    SignatureDoesNotMatch:
      'S3_SECRET_ACCESS_KEY does not match the key id, or has stray quotes/whitespace.',
    AccessDenied:
      'The key is real but may not write here — grant s3:PutObject on the prefix.',
    NoSuchBucket:
      'S3_BUCKET does not exist in this account, or S3_REGION is the wrong region.',
    RequestTimeTooSkewed:
      "This machine's clock has drifted too far from AWS. Sync the system time.",
    EntityTooLarge:
      'The file is larger than the presigned URL was signed for.',
  };
  if (code && explain[code]) return `${code}: ${explain[code]}`;
  if (code) return `S3 refused it with ${code} (HTTP ${status}).`;
  if (status === 0) return 'The request never reached S3 — this is what missing bucket CORS looks like.';
  return `No S3 error code in the response (HTTP ${status}). Check bucket CORS allows PUT from this origin.`;
}

async function main() {
  let employeeId: number | null = null;
  const createdKeys: string[] = [];
  try {
    const db = process.env.DB_NAME ?? '';
    if (/prod/i.test(db) || db === 'attendance_db') {
      console.log(`REFUSED: DB_NAME is "${db}" — this script writes.`);
      failed += 1;
      return;
    }

    const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (!admin) { check('a super_admin exists', false); return; }
    const tv = await currentTokenVersion(admin.id);
    const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);

    const e = (await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('__DOC1', '__Doc Subject', 'x', 'employee', 1)`,
    )) as unknown as { insertId: number };
    employeeId = e.insertId;
    const params = { params: Promise.resolve({ id: String(employeeId) }) };

    const post = (body: unknown, path = '') =>
      new NextRequest(`http://localhost:3000/api/employees/${employeeId}/documents${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
        body: JSON.stringify(body),
      });

    console.log('\n— key layout —');
    const key = buildKey(employeeId, 'aadhaar_card', 'My Scan.JPG');
    check('keys are namespaced per employee', key.startsWith(keyPrefixFor(employeeId) + '/'), key);
    check('…and per document type', key.includes('/aadhaar_card/'));
    check('the original filename is NOT in the key',
      !key.toLowerCase().includes('my') && !key.toLowerCase().includes('scan'),
      'a bucket listing should not disclose what somebody filed');
    check('the extension is preserved, lowercased', key.endsWith('.jpg'));
    check('two keys for the same file never collide',
      buildKey(employeeId, 'aadhaar_card', 'My Scan.JPG') !== key);

    console.log('\n— the type list covers government ID —');
    for (const t of ['aadhaar_card', 'pan_card', 'government_id', 'passport', 'driving_licence', 'voter_id']) {
      check(`"${t}" is an accepted document type`, (DOCUMENT_TYPES as readonly string[]).includes(t));
    }

    console.log('\n— storage status —');
    const status = await statusRoute(
      new NextRequest(`http://localhost:3000/api/employees/${employeeId}/documents/presign`,
        { headers: { Cookie: `access_token=${token}` } }),
      params,
    );
    eq('status is readable', status.status, 200);
    const st = (await status.json()).data as ReturnType<typeof storageStatus>;
    eq('it agrees with the library', st.configured, isS3Configured());
    check('it never returns the credentials',
      !JSON.stringify(st).includes('SECRET') && !JSON.stringify(st).match(/AKIA/),
      'bucket and region are fine to show; keys are not');

    if (!isS3Configured()) {
      console.log('\n— NO BUCKET: the database path must still work —');
      eq('presigning is refused, with a 503 that explains itself',
        (await presignRoute(post({
          doc_type: 'aadhaar_card', file_name: 'a.png', mime_type: 'image/png', size_bytes: 100,
        }, '/presign'), params)).status, 503);

      const up = await uploadRoute(post({
        doc_type: 'aadhaar_card', title: 'Aadhaar', file_name: 'a.png',
        mime_type: 'image/png', data_base64: PNG_B64,
      }), params);
      eq('a database upload still succeeds', up.status, 201);
      const docId = ((await up.json()).data as { document: { id: number } }).document.id;

      const row = await queryOne<{ storage: string; s3_key: string | null; file_data: string | null }>(
        `SELECT storage, s3_key, file_data FROM employee_documents WHERE id = ?`, [docId],
      );
      eq('it is recorded as database-stored', row?.storage, 'db');
      eq('with no S3 key', row?.s3_key, null);
      check('and the bytes are inline', Boolean(row?.file_data));

      const dl = await downloadRoute(
        new NextRequest(`http://localhost:3000/x`, { headers: { Cookie: `access_token=${token}` } }),
        { params: Promise.resolve({ id: String(employeeId), docId: String(docId) }) },
      );
      eq('it downloads as bytes, exactly as before', dl.status, 200);
      eq('with the right content type', dl.headers.get('content-type'), 'image/png');

      eq('an upload with neither bytes nor a key is refused',
        (await uploadRoute(post({
          doc_type: 'other', title: 'x', file_name: 'a.png', mime_type: 'image/png',
        }), params)).status, 400);

      eq('and an s3_key is refused when S3 is off',
        (await uploadRoute(post({
          doc_type: 'other', title: 'x', file_name: 'a.png', mime_type: 'image/png',
          s3_key: `${keyPrefixFor(employeeId)}/other/made-up.png`,
        }), params)).status, 503);
    } else {
      console.log('\n— BUCKET CONFIGURED: the S3 path —');
      const pre = await presignRoute(post({
        doc_type: 'aadhaar_card', file_name: 'a.png', mime_type: 'image/png',
        size_bytes: Buffer.from(PNG_B64, 'base64').length,
      }, '/presign'), params);
      eq('a presigned upload URL is issued', pre.status, 200);
      const { upload_url, key: issued } = (await pre.json()).data as { upload_url: string; key: string };
      createdKeys.push(issued);
      check('the URL is for the configured bucket', upload_url.includes('https://'), upload_url.slice(0, 40));

      // The signature covers a fixed list of headers, and whoever PUTs the file
      // must reproduce every one of them exactly or S3 answers
      // SignatureDoesNotMatch. The browser sends Content-Type and lets fetch set
      // content-length; it sends nothing else. So anything else appearing here is
      // a URL no browser can use - which is a bug in presignUpload, not in the
      // bucket or the key. This check needs no working credentials, because
      // presigning never contacts AWS.
      const signed = (new URL(upload_url).searchParams.get('X-Amz-SignedHeaders') ?? '')
        .split(';').map(h => h.trim().toLowerCase()).filter(Boolean);
      const sendable = new Set(['host', 'content-type', 'content-length']);
      const unsendable = signed.filter(h => !sendable.has(h));
      check('the signed headers are all ones the browser actually sends',
        unsendable.length === 0,
        unsendable.length ? `browser cannot send: ${unsendable.join(', ')}` : signed.join(';'));

      const bytes = Buffer.from(PNG_B64, 'base64');
      const put = await fetch(upload_url, {
        method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes,
      });
      // Read the body only on failure. S3's InvalidAccessKeyId response quotes
      // the access key back at you, so the raw body is never printed - only the
      // <Code> element, which names the cause without naming the key.
      const putBody = put.ok ? '' : await put.text().catch(() => '');
      check('the object uploads', put.ok, `HTTP ${put.status}`);

      const head = await headObject(issued);
      check('and is really there', head.exists, `${head.size} bytes`);

      // Stop here rather than cascading. A presigned URL is signed locally and
      // never contacts AWS, so bad credentials produce a perfectly valid URL
      // whose PUT then fails — everything after this point would report
      // follow-on noise instead of the one fact that matters.
      if (!put.ok || !head.exists) {
        console.log('\n  The bucket is configured but the upload did not land.');
        console.log(`  ${diagnoseUploadFailure(putBody, put.status)}`);
        console.log('  Note the server correctly REFUSED to file a document whose object is absent.');
        const refused = await uploadRoute(post({
          doc_type: 'aadhaar_card', title: 'Aadhaar', file_name: 'a.png',
          mime_type: 'image/png', s3_key: issued,
        }), params);
        eq('filing an object that never arrived is refused', refused.status, 400);
        return;
      }

      const up = await uploadRoute(post({
        doc_type: 'aadhaar_card', title: 'Aadhaar', file_name: 'a.png',
        mime_type: 'image/png', s3_key: issued,
      }), params);
      eq('it is filed', up.status, 201);
      const docId = ((await up.json()).data as { document: { id: number } }).document.id;

      const row = await queryOne<{ storage: string; s3_key: string; file_data: string | null }>(
        `SELECT storage, s3_key, file_data FROM employee_documents WHERE id = ?`, [docId],
      );
      eq('recorded as S3-stored', row?.storage, 's3');
      eq('with the key', row?.s3_key, issued);
      eq('and NO bytes in the database', row?.file_data, null);

      const dl = await downloadRoute(
        new NextRequest(`http://localhost:3000/x`, { headers: { Cookie: `access_token=${token}` } }),
        { params: Promise.resolve({ id: String(employeeId), docId: String(docId) }) },
      );
      eq('downloading redirects to a signed link', dl.status, 302);
      const loc = dl.headers.get('location') ?? '';
      check('…which is time-limited', /X-Amz-Expires=/.test(loc), loc.slice(0, 60));

      console.log('\n— the two checks that stop a bad upload being filed —');
      eq('a key that never uploaded is refused',
        (await uploadRoute(post({
          doc_type: 'other', title: 'x', file_name: 'b.png', mime_type: 'image/png',
          s3_key: `${keyPrefixFor(employeeId)}/other/never-uploaded.png`,
        }), params)).status, 400);
      eq("another employee's key is refused",
        (await uploadRoute(post({
          doc_type: 'other', title: 'x', file_name: 'b.png', mime_type: 'image/png',
          s3_key: `${keyPrefixFor(employeeId + 99_999)}/other/someone-else.png`,
        }), params)).status, 400);

      console.log('\n— deleting removes the object too —');
      const del = await deleteRoute(
        new NextRequest(`http://localhost:3000/x`, {
          method: 'DELETE', headers: { Cookie: `access_token=${token}` },
        }),
        { params: Promise.resolve({ id: String(employeeId), docId: String(docId) }) },
      );
      eq('the document is deleted', del.status, 200);
      check('and the object is gone from the bucket', !(await headObject(issued)).exists);
      createdKeys.length = 0;
    }

    console.log('\n— access control is unchanged —');
    const stranger = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'employee' AND id <> ? AND is_active = 1 LIMIT 1`,
      [employeeId],
    );
    if (stranger) {
      const stv = await currentTokenVersion(stranger.id);
      const stoken = signAccessToken({ id: stranger.id, emp_id: stranger.emp_id, role: stranger.role, tv: stv } as never);
      const denied = await statusRoute(
        new NextRequest(`http://localhost:3000/api/employees/${employeeId}/documents/presign`,
          { headers: { Cookie: `access_token=${stoken}` } }),
        params,
      );
      eq("one employee cannot touch another's documents", denied.status, 403);
    }
  } finally {
    for (const k of createdKeys) {
      try { await deleteObject(k); } catch { /* best effort */ }
    }
    if (employeeId) {
      await query(`DELETE FROM employee_documents WHERE employee_id = ?`, [employeeId]);
      await query(`DELETE FROM employees WHERE id = ?`, [employeeId]);
    }
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id = '__DOC1'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });
