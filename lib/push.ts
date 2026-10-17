import { readFileSync } from 'fs';
import jwt from 'jsonwebtoken';
import { query, queryOne } from '@/lib/db';

// ---------------------------------------------------------------------------
// Push notifications — the server telling a phone something AS IT HAPPENS.
//
// Until now every notification was local: the phone polled and announced what
// it found. Open, that is every minute; closed, only when Android allows a
// background task, which on most phones is hours later or never. So approvals
// "only came when they opened the app" — because that is when the phone asked.
//
// Sent straight to Firebase Cloud Messaging (FCM), the channel Android itself
// uses to wake an app, with the Firebase project's service-account key:
//
//   FIREBASE_SERVICE_ACCOUNT_FILE=/path/to/attendance-27e7f-firebase-adminsdk-….json
//     (or FIREBASE_SERVICE_ACCOUNT_JSON = the file's contents, raw or base64)
//
// The key is a secret — it lets its holder send notifications as this app — so
// it lives on the server only, never in the repository or the app. Without it
// nothing is sent and the phone keeps announcing on its own, exactly as before.
// `node scripts/check-push.js` says whether a key works.
//
// Nothing in here throws: a notification must never fail the action that
// prompted it.
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 10_000;

const SCHEMA_RECHECK_MS = 30_000;
let tableReady = false;
let tableCheckedAt = 0;

export async function hasPushTable(): Promise<boolean> {
  if (tableReady) return true;
  if (Date.now() - tableCheckedAt < SCHEMA_RECHECK_MS) return false;
  tableCheckedAt = Date.now();
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'push_tokens'`,
  ).catch(() => null);
  tableReady = Number(row?.n ?? 0) > 0;
  return tableReady;
}

/** An FCM registration token: one long run of URL-safe characters. */
export function isPushToken(token: string): boolean {
  return /^[A-Za-z0-9_:.-]{32,512}$/.test(token);
}

/** Records the phone's push address against the employee signed in on it. */
export async function registerPushToken(
  employeeId: number,
  token: string,
  deviceId: string | null,
  platform: string | null,
): Promise<boolean> {
  if (!(await hasPushTable())) return false;
  // A phone that changes hands moves its row to the new employee.
  await query(
    `INSERT INTO push_tokens (employee_id, token, device_id, platform)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), device_id = VALUES(device_id),
                             platform = VALUES(platform), last_seen_at = UTC_TIMESTAMP()`,
    [employeeId, token, deviceId, platform],
  );
  // One address per install: the old token of a reinstalled or refreshed app
  // would otherwise collect that phone's notifications twice.
  if (deviceId) {
    await query('DELETE FROM push_tokens WHERE device_id = ? AND token <> ?', [deviceId, token]);
  }
  return true;
}

/** Stops pushes to one phone (signing out of it), or to all of an employee's
 *  phones when no device is named (a PIN reset). */
export async function forgetPushTokens(employeeId: number, deviceId?: string | null): Promise<void> {
  if (!(await hasPushTable())) return;
  if (deviceId) {
    await query('DELETE FROM push_tokens WHERE employee_id = ? AND device_id = ?', [employeeId, deviceId]);
  } else {
    await query('DELETE FROM push_tokens WHERE employee_id = ?', [employeeId]);
  }
}

// ---------------------------------------------------------------------------
// The service account and its access token
// ---------------------------------------------------------------------------

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

/** undefined = not read yet; null = not configured or unusable. */
let account: ServiceAccount | null | undefined;

function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  account = null;
  try {
    const file = process.env.FIREBASE_SERVICE_ACCOUNT_FILE?.trim();
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    const raw = file
      ? readFileSync(file, 'utf8')
      : inline
        ? (inline.startsWith('{') ? inline : Buffer.from(inline, 'base64').toString('utf8'))
        : null;
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!j.project_id || !j.client_email || !j.private_key) {
      throw new Error('missing project_id, client_email or private_key');
    }
    account = { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key };
  } catch (err) {
    console.warn('[push] Firebase service account unusable — pushes are off:',
      err instanceof Error ? err.message : err);
  }
  return account;
}

/** True when a Firebase key is configured, so pushes can be attempted. */
export function pushConfigured(): boolean {
  return serviceAccount() !== null;
}

let cachedAccess: { token: string; expiresAt: number } | null = null;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** A Google OAuth access token for FCM, kept until five minutes before it expires. */
async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt - 5 * 60_000) return cachedAccess.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: 'RS256' },
  );
  const res = await timedFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const json = await res.json().catch(() => null) as { access_token?: string; expires_in?: number; error_description?: string } | null;
  if (!res.ok || !json?.access_token) {
    throw new Error(`Google refused the Firebase key (${res.status}): ${json?.error_description ?? 'no detail'}`);
  }
  cachedAccess = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedAccess.token;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface PushMessage {
  title: string;
  body: string;
  /** Read by the app when it is open — e.g. which decision this announces. */
  data?: Record<string, unknown>;
  /** Android channel: the app's existing channels carry the sound and priority. */
  channelId?: string;
}

type SendOutcome = 'sent' | 'dead_token' | 'failed';

/** One message to one phone. `validateOnly` asks FCM to check without delivering. */
export async function sendToToken(token: string, msg: PushMessage, validateOnly = false): Promise<{ outcome: SendOutcome; detail?: string }> {
  const sa = serviceAccount();
  if (!sa) return { outcome: 'failed', detail: 'no Firebase key configured' };
  const bearer = await accessToken(sa);
  const res = await timedFetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      validate_only: validateOnly,
      message: {
        token,
        notification: { title: msg.title, body: msg.body },
        // FCM carries data as strings only.
        data: Object.fromEntries(Object.entries(msg.data ?? {}).map(([k, v]) => [k, String(v)])),
        android: {
          priority: 'HIGH',
          notification: { sound: 'default', ...(msg.channelId ? { channel_id: msg.channelId } : {}) },
        },
      },
    }),
  });
  if (res.ok) return { outcome: 'sent' };
  const err = await res.json().catch(() => null) as
    { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } } | null;
  const code = err?.error?.details?.find(d => d.errorCode)?.errorCode ?? err?.error?.status ?? `HTTP ${res.status}`;
  if (res.status === 401) cachedAccess = null; // let the next send fetch a fresh access token
  // UNREGISTERED: uninstalled, or the token was replaced. A malformed token is
  // just as dead. Neither can ever receive anything.
  const dead = code === 'UNREGISTERED'
    || (code === 'INVALID_ARGUMENT' && /registration token/i.test(err?.error?.message ?? ''));
  return { outcome: dead ? 'dead_token' : 'failed', detail: `${code}: ${err?.error?.message ?? ''}`.trim() };
}

/**
 * Push to every phone the employee is signed in on. `onDelivered` runs when
 * Firebase accepted it for at least one of them — the moment the phone may
 * stop announcing the same news itself.
 */
export async function pushToEmployee(
  employeeId: number,
  msg: PushMessage,
  onDelivered?: () => Promise<void>,
): Promise<void> {
  try {
    if (!(await hasPushTable()) || !serviceAccount()) return;
    const rows = await query<{ token: string }>(
      `SELECT pt.token
         FROM push_tokens pt
         JOIN employees e ON e.id = pt.employee_id AND e.is_active = TRUE
        WHERE pt.employee_id = ?`,
      [employeeId],
    );
    let delivered = false;
    for (const { token } of rows) {
      const { outcome, detail } = await sendToToken(token, msg).catch(e => (
        { outcome: 'failed' as const, detail: e instanceof Error ? e.message : String(e) }
      ));
      if (outcome === 'sent') delivered = true;
      else if (outcome === 'dead_token') await query('DELETE FROM push_tokens WHERE token = ?', [token]).catch(() => {});
      else console.warn(`[push] not delivered: ${detail}`);
    }
    if (delivered && onDelivered) await onDelivered();
  } catch (err) {
    console.warn('[push] send failed:', err instanceof Error ? err.message : err);
  }
}
