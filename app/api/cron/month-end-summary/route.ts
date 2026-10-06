import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { buildPayrollPack } from '@/lib/payrollExport';
import { findExceptions } from '@/lib/exceptions';
import { sendMonthEndSummary, type MonthEndRow } from '@/lib/mailer';

// ---------------------------------------------------------------------------
// POST /api/cron/month-end-summary
//
//   x-cron-secret: <CRON_SECRET>
//   ?month=2026-09   (defaults to the month that just ended)
//   ?dry_run=1       build everything, send nothing, report what it would do
//
// Sends each administrator the month's hours, how many things need a decision,
// and who finished short.
//
// Run it on the 1st:
//   5 7 1 * *  curl -fsS -X POST -H "x-cron-secret: $SECRET" \
//                https://<host>/api/cron/month-end-summary
//
// NOTE: sending depends on SMTP_FROM being a verified SES identity. At the time
// of writing it is not, and SES has rejected over a thousand alert emails for
// that reason. The dry run exists so this can be proven correct before the
// mailbox works — and the response always reports what actually happened, so a
// silent failure is visible rather than assumed to be success.
// ---------------------------------------------------------------------------

/** The month that has just finished, in IST. */
function previousMonth(): string {
  const todayIst = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m] = todayIst.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const hm = (m: number) => {
  const v = Math.max(0, Math.round(m));
  return `${Math.floor(v / 60)}h ${String(v % 60).padStart(2, '0')}m`;
};
const signed = (m: number) => `${m < 0 ? '−' : '+'}${hm(Math.abs(m))}`;

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const sp = new URL(request.url).searchParams;
  const month = sp.get('month') ?? previousMonth();
  const dryRun = sp.get('dry_run') === '1';

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ success: false, error: 'month must be YYYY-MM' }, { status: 400 });
  }

  const pack = await buildPayrollPack(month);
  const exceptions = await findExceptions(pack.period.from_date, pack.period.to_date);

  const rows: MonthEndRow[] = pack.rows.map(r => ({
    name: r.name,
    emp_id: r.emp_id,
    required_display: hm(r.required_minutes),
    worked_display: hm(r.worked_minutes),
    net_display: signed(r.net_minutes),
    short: r.net_minutes < 0,
  }));

  const recipients = await query<{ email: string; name: string }>(
    `SELECT email, name FROM employees
      WHERE is_active = TRUE AND role IN ('super_admin', 'manager')
        AND email IS NOT NULL AND email <> ''`,
  );

  const data = {
    month_label: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }),
    closed: Boolean(pack.closure?.is_closed),
    closed_by: pack.closure?.closed_by_name ?? null,
    employees: pack.rows.length,
    required_display: hm(pack.totals.required_minutes),
    worked_display: hm(pack.totals.worked_minutes),
    exceptions: {
      critical: exceptions.counts.critical,
      warning: exceptions.counts.warning,
      info: exceptions.counts.info,
    },
    rows,
    checksum: pack.checksum,
    app_url: process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? null,
  };

  if (dryRun) {
    return NextResponse.json({
      success: true,
      dry_run: true,
      month,
      would_send_to: recipients.map(r => r.email),
      summary: {
        employees: data.employees,
        short: rows.filter(r => r.short).length,
        closed: data.closed,
        exceptions: data.exceptions,
        checksum: pack.checksum,
      },
    });
  }

  if (recipients.length === 0) {
    return NextResponse.json({
      success: true, month, sent: 0,
      note: 'No active administrator has an email address on record, so nothing was sent.',
    });
  }

  // sendMonthEndSummary never throws — the mailer swallows failures so a dead
  // mailbox cannot break a cron run. That means "sent" below counts attempts,
  // not deliveries, and the note says so rather than implying success.
  let attempted = 0;
  for (const r of recipients) {
    await sendMonthEndSummary(r.email, data);
    attempted += 1;
  }

  return NextResponse.json({
    success: true,
    month,
    sent: attempted,
    recipients: recipients.map(r => r.email),
    note: 'Delivery is not confirmed here — the mailer logs failures rather than '
      + 'throwing, so check the application log if nothing arrives.',
  });
}
