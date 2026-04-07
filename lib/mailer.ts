import nodemailer from 'nodemailer';
import { format } from 'date-fns';

// ---------------------------------------------------------------------------
// Transporter — created once and reused for all sends.
// ---------------------------------------------------------------------------

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465, // true only for port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

const FROM = process.env.SMTP_FROM ?? 'noreply@company.com';

// ---------------------------------------------------------------------------
// Internal send helper — all errors are caught and logged so that email
// failures never propagate to the caller and never break clock-in/out.
// ---------------------------------------------------------------------------

async function send(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  try {
    await transporter.sendMail({ from: FROM, to, subject, html });
  } catch (err) {
    console.error('[mailer] Failed to send email:', {
      to,
      subject,
      error: (err as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notify an admin that an employee clocked in late.
 * Fails silently — never throws.
 */
export async function sendLateAlert(
  adminEmail: string,
  employeeName: string,
  clockInTime: Date,
): Promise<void> {
  const timeStr = format(clockInTime, 'hh:mm a');
  const dateStr = format(clockInTime, 'dd MMM yyyy');

  await send(
    adminEmail,
    `Late Arrival: ${employeeName}`,
    `
      <p>Hi,</p>
      <p>
        <strong>${employeeName}</strong> clocked in late at
        <strong>${timeStr}</strong> on <strong>${dateStr}</strong>.
      </p>
      <p>This is an automated notification from the Attendance System.</p>
    `,
  );
}

/**
 * Notify an admin that an employee is absent.
 * Fails silently — never throws.
 */
export async function sendAbsentAlert(
  adminEmail: string,
  employeeName: string,
  date: Date,
): Promise<void> {
  const dateStr = format(date, 'dd MMM yyyy');

  await send(
    adminEmail,
    `Absent: ${employeeName} — ${dateStr}`,
    `
      <p>Hi,</p>
      <p>
        <strong>${employeeName}</strong> has not clocked in and is marked
        <strong>absent</strong> for <strong>${dateStr}</strong>.
      </p>
      <p>This is an automated notification from the Attendance System.</p>
    `,
  );
}

export interface DailySummaryData {
  present: number;
  absent: number;
  late: number;
  date: Date;
}

/**
 * Send a daily attendance summary to an admin.
 * Fails silently — never throws.
 */
export async function sendDailySummary(
  adminEmail: string,
  summary: DailySummaryData,
): Promise<void> {
  const dateStr = format(summary.date, 'EEEE, dd MMM yyyy');
  const total = summary.present + summary.absent + summary.late;

  await send(
    adminEmail,
    `Daily Attendance Summary — ${dateStr}`,
    `
      <p>Hi,</p>
      <p>Here is the attendance summary for <strong>${dateStr}</strong>:</p>
      <table cellpadding="6" style="border-collapse:collapse;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="border:1px solid #e5e7eb;text-align:left;">Status</th>
            <th style="border:1px solid #e5e7eb;text-align:right;">Count</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="border:1px solid #e5e7eb;">Present (on time)</td>
            <td style="border:1px solid #e5e7eb;text-align:right;">${summary.present}</td>
          </tr>
          <tr>
            <td style="border:1px solid #e5e7eb;">Late</td>
            <td style="border:1px solid #e5e7eb;text-align:right;">${summary.late}</td>
          </tr>
          <tr>
            <td style="border:1px solid #e5e7eb;">Absent</td>
            <td style="border:1px solid #e5e7eb;text-align:right;">${summary.absent}</td>
          </tr>
          <tr style="font-weight:bold;">
            <td style="border:1px solid #e5e7eb;">Total employees</td>
            <td style="border:1px solid #e5e7eb;text-align:right;">${total}</td>
          </tr>
        </tbody>
      </table>
      <p>This is an automated notification from the Attendance System.</p>
    `,
  );
}
