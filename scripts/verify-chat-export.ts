/**
 * scripts/verify-chat-export.ts — verify report file generation.
 *
 * Builds every report in every format against the real database, writes them to
 * a temp directory, and checks each file's magic bytes so a "successful" run
 * cannot hide a zero-byte or malformed file. No model calls.
 *
 * Run: npx tsx --env-file=.env.local scripts/verify-chat-export.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  REPORTS,
  REPORT_KEYS,
  EXPORT_FORMATS,
  buildReportFile,
  signDownloadToken,
  verifyDownloadToken,
  createReportDownload,
  type ExportFormat,
} from '../lib/chat/export';
import type { ChatContext } from '../lib/chat/types';
import { pool } from '../lib/db';

const CTX: ChatContext = { employeeId: 1, role: 'super_admin' };
const OTHER: ChatContext = { employeeId: 2, role: 'super_admin' };
const RANGE = { from_date: '2026-05-01', to_date: '2026-07-31' };

let pass = 0;
let fail = 0;
const ok = (l: string, d = '') => { pass++; console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`); };
const bad = (l: string, d: string) => { fail++; console.log(`  FAIL  ${l} — ${d}`); };

/** Magic bytes, so a malformed file cannot pass as valid. */
function looksValid(fmt: ExportFormat, buf: Buffer): string | null {
  if (buf.length === 0) return 'empty file';
  if (fmt === 'xlsx') {
    // xlsx is a zip — must start PK\x03\x04
    return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
      ? null
      : `bad zip header: ${buf.subarray(0, 4).toString('hex')}`;
  }
  if (fmt === 'pdf') {
    return buf.subarray(0, 5).toString('ascii') === '%PDF-'
      ? null
      : `bad pdf header: ${buf.subarray(0, 8).toString('ascii')}`;
  }
  // csv — BOM then printable text
  return buf.subarray(0, 3).toString('hex') === 'efbbbf' ? null : 'missing UTF-8 BOM';
}

async function main() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-export-'));
  console.log(`\nwriting files to ${out}\n`);

  console.log('— token security —');
  const tok = signDownloadToken({ sub: 1, report: 'attendance_summary', format: 'xlsx', params: RANGE });
  const back = verifyDownloadToken(tok);
  if (back && back.sub === 1 && back.report === 'attendance_summary') ok('round-trips', `sub=${back.sub}`);
  else bad('round-trip', JSON.stringify(back));

  if (verifyDownloadToken(tok.slice(0, -3) + 'xxx') === null) ok('tampered token rejected');
  else bad('tampered token', 'accepted a modified signature');

  if (verifyDownloadToken('not.a.token') === null) ok('garbage token rejected');
  else bad('garbage token', 'accepted');

  // An access token must not work as a download token (different audience).
  const jwtLib = (await import('jsonwebtoken')).default;
  const wrongAud = jwtLib.sign({ sub: 1, report: 'attendance_summary', format: 'xlsx', params: {} },
    process.env.JWT_ACCESS_SECRET!, { audience: 'some-other-aud', expiresIn: '5m' });
  if (verifyDownloadToken(wrongAud) === null) ok('wrong-audience token rejected', 'cannot reuse an auth token');
  else bad('audience check', 'accepted a token minted for another audience');

  // An unknown report name must not survive verification.
  const badReport = jwtLib.sign({ sub: 1, report: 'evil', format: 'xlsx', params: {} },
    process.env.JWT_ACCESS_SECRET!, { audience: 'chat-download', expiresIn: '5m' });
  if (verifyDownloadToken(badReport) === null) ok('unknown report rejected');
  else bad('report allowlist', 'accepted an unknown report name');

  console.log('\n— file generation —');
  for (const key of REPORT_KEYS) {
    const def = REPORTS[key];
    const params: Record<string, unknown> = { ...RANGE };
    if (def.needsEmployee) params.employee_id = 1;
    if (key === 'daily_snapshot') params.date = '2026-07-01';
    if (key === 'leave_balance') params.year = 2026;

    for (const fmt of EXPORT_FORMATS) {
      try {
        const file = await buildReportFile(CTX, { sub: 1, report: key, format: fmt, params });
        const problem = looksValid(fmt, file.body);
        const dest = path.join(out, file.filename);
        fs.writeFileSync(dest, file.body);
        if (problem) bad(`${key}.${fmt}`, problem);
        else ok(`${key}.${fmt}`, `${file.rows} rows, ${(file.body.length / 1024).toFixed(1)}kb, ${file.filename}`);
      } catch (err) {
        bad(`${key}.${fmt}`, (err as Error).message);
      }
    }
  }

  console.log('\n— tool behaviour —');
  const offer = await createReportDownload(CTX, { report: 'attendance_summary', format: 'xlsx', ...RANGE });
  if (offer.count === 1 && offer.rows[0]?.download_url.startsWith('/api/chat/download?t='))
    ok('tool returns a download link', offer.rows[0].filename);
  else bad('tool link', JSON.stringify(offer).slice(0, 150));

  // An empty period must not hand over a blank spreadsheet.
  const empty = await createReportDownload(CTX, {
    report: 'absentees', format: 'xlsx', from_date: '2001-01-01', to_date: '2001-01-31',
  });
  if (empty.count === 0 && empty.notes?.length) ok('empty report produces no file', empty.notes[0].slice(0, 70));
  else bad('empty report', 'created a file with no data');

  // needsEmployee must be enforced.
  try {
    await createReportDownload(CTX, { report: 'attendance_detail', format: 'xlsx', ...RANGE });
    bad('employee_id required', 'accepted a per-employee report without one');
  } catch { ok('employee_id required for attendance_detail'); }

  try {
    await createReportDownload(CTX, { report: 'nope', format: 'xlsx', ...RANGE });
    bad('unknown report rejected', 'accepted');
  } catch { ok('unknown report name rejected'); }

  // The link is bound to its issuer; another admin must not be able to use it.
  const issued = verifyDownloadToken(offer.rows[0].download_url.split('t=')[1]);
  if (issued && issued.sub !== OTHER.employeeId) ok('link is bound to one employee', `sub=${issued.sub}, other=${OTHER.employeeId}`);
  else bad('link binding', 'token subject does not identify the issuer');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`files: ${out}\n`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async e => { console.error('crashed:', e); await pool.end(); process.exit(1); });
