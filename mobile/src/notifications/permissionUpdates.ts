import * as Notifications from 'expo-notifications';
import { getState, setState } from '../storage/state';
import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Tell the employee when their permission request is decided.
//
// There is no push server. The phone already polls /api/attendance/today from
// the dashboard and the background watch; the server now includes recently
// reviewed requests in that response, and this module raises ONE local
// notification per decision, remembering which ids it has announced so a
// verdict is never repeated however often the poll runs.
//
// Before this, approval changed a status silently in a list nobody was looking
// at — employees found out by asking, which is how "your permission has
// approved message not receive" became a bug report.
// ---------------------------------------------------------------------------

const ANNOUNCED_KEY = 'perm_updates_announced';
import { notify as sharedNotify, CHANNELS } from './setup';
// The server only sends decisions from the last 3 days, so the dedup set can
// stay small — keep the most recent ids and let ancient ones fall off.
const MAX_REMEMBERED = 100;

export interface PermissionUpdate {
  id: number;
  request_type: string;
  permission_date: string; // YYYY-MM-DD
  start_time: string;      // HH:MM[:SS]
  end_time: string;
  status: string;          // approved | rejected
  review_notes: string | null;
  /** Already delivered to this phone by push (see notifications/push.ts). */
  pushed?: boolean;
}

/** Decision ids carried by pushes this phone has received. A push and this
 *  module's own announcement say the same thing; whichever came first, the
 *  other must not repeat it. */
function decisionId(data: unknown): number | null {
  const d = data as { kind?: unknown; id?: unknown } | null | undefined;
  if (d?.kind !== 'permission_decision') return null;
  // Firebase carries every data value as a string.
  const id = typeof d.id === 'number' ? d.id : Number(d.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Record a decision as announced — e.g. a push that arrived while the app was open. */
export async function markDecisionAnnounced(data: unknown): Promise<void> {
  const id = decisionId(data);
  if (id == null) return;
  const seen = await announced();
  if (seen.includes(id)) return;
  seen.push(id);
  await setState(ANNOUNCED_KEY, JSON.stringify(seen.slice(-MAX_REMEMBERED)));
}

/** Decisions sitting in the notification tray right now, put there by push. */
async function decisionsInTray(): Promise<Set<number>> {
  const shown = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  const ids = new Set<number>();
  for (const n of shown) {
    const id = decisionId(n.request.content.data);
    if (id != null) ids.add(id);
  }
  return ids;
}

function dmy(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return d && m && y ? `${d}-${m}-${y}` : ymd;
}
function hhmm(t: string): string {
  return t ? t.slice(0, 5) : '';
}

async function announced(): Promise<number[]> {
  try {
    const raw = await getState(ANNOUNCED_KEY);
    const arr = raw ? (JSON.parse(raw) as number[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Announce any decision not yet announced. Safe to call on every poll. */
export async function notifyPermissionUpdates(updates: PermissionUpdate[] | undefined): Promise<void> {
  if (!updates?.length) return;
  const seen = await announced();
  const fresh = updates.filter(u => (u.status === 'approved' || u.status === 'rejected') && !seen.includes(u.id));
  if (!fresh.length) return;

  // Already told by push: confirmed delivered by the server, or in the tray
  // now. Recorded, not repeated.
  const inTray = await decisionsInTray();

  for (const u of fresh) {
    if (u.pushed || inTray.has(u.id)) {
      seen.push(u.id);
      continue;
    }
    const kind = u.request_type === 'on_duty' ? 'On-duty request' : 'Permission request';
    const window = `${dmy(u.permission_date)}, ${hhmm(u.start_time)}–${hhmm(u.end_time)}`;
    try {
      const ok = await sharedNotify(
        CHANNELS.permission,
        u.status === 'approved' ? `${kind} approved ✅` : `${kind} rejected`,
        u.status === 'approved'
          ? `Your ${window} request was approved.${u.review_notes ? ` Note: ${u.review_notes}` : ''}`
          : `Your ${window} request was rejected.${u.review_notes ? ` Reason: ${u.review_notes}` : ' Speak to your manager for details.'}`,
      );
      // Not shown means not announced — see below.
      if (ok === false) continue;
    } catch {
      // If the notification could not be shown, do NOT mark it announced —
      // the next poll retries rather than swallowing the verdict.
      continue;
    }
    seen.push(u.id);
  }

  await setState(ANNOUNCED_KEY, JSON.stringify(seen.slice(-MAX_REMEMBERED)));
}
