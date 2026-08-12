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

export interface LiveTrackingAlertData {
  employeeName: string;
  empId: string;
  reason: 'stale_ping' | 'manual_stop';
  detectedAt: Date;
  sessionId: number;
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

/**
 * Notify an admin when live tracking was interrupted or manually stopped.
 * Fails silently — never throws.
 */
export async function sendLiveTrackingAlert(
  adminEmail: string,
  payload: LiveTrackingAlertData,
): Promise<void> {
  const detectedAtStr = format(payload.detectedAt, 'dd MMM yyyy, hh:mm a');
  const reasonText =
    payload.reason === 'stale_ping'
      ? 'Location signal lost (no tracking updates received)'
      : 'Employee manually stopped live tracking';

  await send(
    adminEmail,
    `Live Tracking Alert: ${payload.employeeName} (${payload.empId})`,
    `
      <p>Hi,</p>
      <p><strong>Live tracking alert</strong> was triggered.</p>
      <ul>
        <li><strong>Employee:</strong> ${payload.employeeName} (${payload.empId})</li>
        <li><strong>Reason:</strong> ${reasonText}</li>
        <li><strong>Detected At:</strong> ${detectedAtStr}</li>
        <li><strong>Session ID:</strong> ${payload.sessionId}</li>
      </ul>
      <p>Please review attendance and live tracking logs for this employee.</p>
    `,
  );
}

// ---------------------------------------------------------------------------
// A request is waiting for an admin's decision
// ---------------------------------------------------------------------------

export interface PermissionRequestData {
  employeeName: string;
  empId: string;
  requestType: 'permission' | 'on_duty';
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
  reason: string | null;
}

/**
 * Tell an admin a request needs approving. On-duty especially matters: until it
 * is approved the geofence will still clock the employee out when they leave.
 * Fails silently — never throws.
 */
export async function sendPermissionRequestAlert(
  adminEmail: string,
  payload: PermissionRequestData,
): Promise<void> {
  const onDuty = payload.requestType === 'on_duty';
  const label = onDuty ? 'On-Duty (work outside the office)' : 'Permission (time off)';
  const hours = `${Math.floor(payload.minutes / 60)}h ${payload.minutes % 60}m`;

  await send(
    adminEmail,
    `${onDuty ? 'On-Duty' : 'Permission'} request awaiting approval: ${payload.employeeName} (${payload.empId})`,
    `
      <p>Hi,</p>
      <p><strong>${payload.employeeName} (${payload.empId})</strong> has requested
      <strong>${label}</strong> and is waiting for your approval.</p>
      <ul>
        <li><strong>Date:</strong> ${payload.date}</li>
        <li><strong>Time:</strong> ${payload.startTime.slice(0, 5)} – ${payload.endTime.slice(0, 5)} (${hours})</li>
        <li><strong>Reason:</strong> ${payload.reason ?? '—'}</li>
      </ul>
      ${onDuty
        ? `<p><strong>Until this is approved, leaving the work site will automatically
           clock them out.</strong> Approving it keeps them clocked in while they are away
           on official work.</p>`
        : `<p>Approved permission hours top their day's total back up to the shift length.</p>`}
      <p>Open the Permissions page to approve or reject it.</p>
    `,
  );
}

// ---------------------------------------------------------------------------
// Geofence auto clock-out alert
// ---------------------------------------------------------------------------

export interface GeofenceAutoClockoutData {
  employeeName: string;
  empId: string;
  locationName: string | null;
  minutesOutside: number;
  detectedAt: Date;
}

export async function sendGeofenceAutoClockoutAlert(
  adminEmail: string,
  payload: GeofenceAutoClockoutData,
): Promise<void> {
  const detectedAtStr = format(payload.detectedAt, 'dd MMM yyyy, hh:mm a');
  await send(
    adminEmail,
    `Geofence Alert: ${payload.employeeName} (${payload.empId}) auto clocked out`,
    `
      <p>Hi,</p>
      <p><strong>${payload.employeeName} (${payload.empId})</strong> stayed outside
      ${payload.locationName ? `<strong>${payload.locationName}</strong>` : 'their work location'}
      for over ${payload.minutesOutside} minutes while clocked in, and has been
      <strong>automatically clocked out</strong>.</p>
      <ul>
        <li><strong>Detected At:</strong> ${detectedAtStr}</li>
      </ul>
      <p>Please review their attendance and tracking history.</p>
    `,
  );
}

// ---------------------------------------------------------------------------
// Clocked in from outside the work site, with a reason
// ---------------------------------------------------------------------------

interface OutOfFenceClockInData {
  employeeName: string;
  empId: string;
  locationName: string | null;
  /** How far outside the fence they were, in metres. */
  distanceM: number | null;
  radiusM: number;
  reason: string;
  latitude: number;
  longitude: number;
  clockedInAt: Date;
}

/**
 * An employee clocked in away from their work site and said why.
 *
 * This is the one alert an admin has to actually read: the fence was not
 * enforced, on that person's own say-so, and the only thing standing behind it
 * is the sentence they typed. The map link is included because "outside the
 * fence" means nothing without knowing whether they were 40 metres away or in
 * another town.
 */
export async function sendOutOfFenceClockInAlert(
  adminEmail: string,
  payload: OutOfFenceClockInData,
): Promise<void> {
  const at = format(payload.clockedInAt, 'dd MMM yyyy, hh:mm a');
  const away = payload.distanceM != null ? `${payload.distanceM} m away` : 'outside the fence';
  await send(
    adminEmail,
    `Off-site clock-in: ${payload.employeeName} (${payload.empId})`,
    `
      <p>Hi,</p>
      <p><strong>${payload.employeeName} (${payload.empId})</strong> clocked in
      <strong>${away}</strong> from
      ${payload.locationName ? `<strong>${payload.locationName}</strong>` : 'their work location'}
      (fence is ${payload.radiusM} m), giving this reason:</p>
      <blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #2563eb;background:#f8fafc">
        ${payload.reason}
      </blockquote>
      <ul>
        <li><strong>Clocked in:</strong> ${at}</li>
        <li><strong>Where:</strong>
          <a href="https://www.google.com/maps?q=${payload.latitude},${payload.longitude}">
            ${payload.latitude.toFixed(6)}, ${payload.longitude.toFixed(6)}
          </a>
        </li>
      </ul>
      <p>Their attendance is marked <strong>outside</strong> for the day. If this was not
      approved, review it in Checkin Records.</p>
    `,
  );
}

// ---------------------------------------------------------------------------
// PIN reset link
// ---------------------------------------------------------------------------

interface PasswordResetData {
  employeeName: string;
  link: string;
  expiresMinutes: number;
}

/**
 * The reset link itself. Unlike every other mail in this file, a FAILURE here
 * matters to the person waiting: the caller catches it and still answers
 * neutrally (so this cannot become an account oracle), but the error reaches
 * the log rather than being lost, and the forgot-password route refuses
 * outright when SMTP is unconfigured instead of pretending to send.
 */
export async function sendPasswordResetEmail(
  to: string,
  payload: PasswordResetData,
): Promise<void> {
  await send(
    to,
    'Reset your Attendance PIN',
    `
      <p>Hi ${payload.employeeName},</p>
      <p>Someone asked to reset the PIN for your Attendance account. Tap the
      button below to choose a new one. The link works once and expires in
      <strong>${payload.expiresMinutes} minutes</strong>.</p>
      <p style="margin:22px 0">
        <a href="${payload.link}"
           style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:8px;
                  text-decoration:none;font-weight:600;display:inline-block">
          Set a new PIN
        </a>
      </p>
      <p style="font-size:13px;color:#475569">
        If the button does not work, copy this into your browser:<br/>
        <span style="word-break:break-all">${payload.link}</span>
      </p>
      <p style="font-size:13px;color:#475569">
        If you did not ask for this, you can ignore this email — your PIN stays
        as it is, and the link expires on its own.
      </p>
    `,
  );
}
