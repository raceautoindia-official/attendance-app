import { query, insertAuditLog } from '@/lib/db';
import { haversineDistance } from '@/lib/geo';

// ---------------------------------------------------------------------------
// How much to believe a set of coordinates.
//
// The clock-in API takes latitude/longitude from the request body, so a fence
// only means something if the coordinates plausibly came from a phone that was
// really there. Two cheap checks catch the realistic abuse:
//
//   • the phone itself says the fix came from a mock-location app
//   • the employee could not physically have travelled from where they last
//     were in the time since
//
// Neither is proof, and neither can stop a determined attacker with a rooted
// device. Both are recorded in the audit log either way, so a pattern is
// visible even where the request is allowed through.
// ---------------------------------------------------------------------------

/**
 * Fastest plausible ground travel. Set high enough that a genuine motorway or
 * rail journey never trips it — this is meant to catch a jump across the
 * country between two fixes minutes apart, not to police driving speed.
 */
const MAX_PLAUSIBLE_KMH = Number(process.env.MAX_TRAVEL_KMH) || 400;

/**
 * Fixes closer together than this are ignored — GPS drift near a building can
 * put two readings a couple of hundred metres apart with nobody moving.
 *
 * There is deliberately no minimum TIME gap: a shorter interval makes a long
 * jump less plausible, not more, so skipping short gaps would wave through the
 * most obvious fakes (clock in at the yard, clock out from another state
 * seconds later). Elapsed time is floored below only to avoid dividing by zero.
 */
const MIN_JUMP_METERS = 500;

export interface LocationClaim {
  latitude: number;
  longitude: number;
  is_mocked?: boolean;
  accuracy_m?: number | null;
}

export interface TrustVerdict {
  ok: boolean;
  reason?: 'mock_location' | 'impossible_travel';
  message?: string;
  /** Details worth keeping on the audit entry. */
  details?: Record<string, unknown>;
}

interface LastFix {
  latitude: number;
  longitude: number;
  at: Date;
}

/** The most recent position recorded for this employee, from any source. */
async function lastKnownFix(employeeId: number): Promise<LastFix | null> {
  const rows = await query<{ lat: number; lng: number; at: string }>(
    `SELECT lat, lng, at FROM (
       SELECT clock_in_lat AS lat, clock_in_lng AS lng, clock_in_utc AS at
       FROM attendance
       WHERE employee_id = ? AND clock_in_lat IS NOT NULL AND clock_in_utc IS NOT NULL
       UNION ALL
       SELECT clock_out_lat AS lat, clock_out_lng AS lng, clock_out_utc AS at
       FROM attendance
       WHERE employee_id = ? AND clock_out_lat IS NOT NULL AND clock_out_utc IS NOT NULL
     ) fixes
     ORDER BY at DESC
     LIMIT 1`,
    [employeeId, employeeId],
  );
  const r = rows[0];
  if (!r || r.lat == null || r.lng == null) return null;
  return { latitude: Number(r.lat), longitude: Number(r.lng), at: new Date(`${r.at}Z`.replace('ZZ', 'Z')) };
}

/**
 * Judge a set of coordinates. `enforce` decides whether a failure blocks the
 * request or is only recorded — the impossible-travel check in particular can
 * misfire on an employee whose previous fix was itself bad, so it is worth
 * being able to run it in report-only mode.
 */
export async function assessLocation(
  employeeId: number,
  claim: LocationClaim,
  context: { action: string; ip: string | null; auto?: boolean },
): Promise<TrustVerdict> {
  if (claim.is_mocked) {
    const verdict: TrustVerdict = {
      ok: false,
      reason: 'mock_location',
      message: 'Your phone reports a simulated location. Turn off any mock-location app and try again.',
      details: { latitude: claim.latitude, longitude: claim.longitude },
    };
    await recordSuspicion(employeeId, context, verdict);
    return verdict;
  }

  const previous = await lastKnownFix(employeeId);
  if (previous && Number.isFinite(previous.at.getTime())) {
    const seconds = Math.max(1, (Date.now() - previous.at.getTime()) / 1000);
    const metres = haversineDistance(
      previous.latitude, previous.longitude, claim.latitude, claim.longitude,
    );
    if (metres >= MIN_JUMP_METERS) {
      const kmh = (metres / 1000) / (seconds / 3600);
      if (kmh > MAX_PLAUSIBLE_KMH) {
        const verdict: TrustVerdict = {
          ok: false,
          reason: 'impossible_travel',
          message:
            `That location is ${Math.round(metres / 1000)} km from where you last clocked, ` +
            `${Math.round(seconds / 60)} minutes ago. Please try again from your work site.`,
          details: {
            km: Math.round(metres / 1000),
            minutes: Math.round(seconds / 60),
            implied_kmh: Math.round(kmh),
            from: { latitude: previous.latitude, longitude: previous.longitude },
            to: { latitude: claim.latitude, longitude: claim.longitude },
          },
        };
        await recordSuspicion(employeeId, context, verdict);
        // An AUTOMATIC event is the phone's own geofence firing, not a typed
        // coordinate — and the previous fix it is compared against may itself
        // be stale or wrong. Blocking it would silently stop automatic
        // attendance for someone who did nothing, so record and let it through.
        // A mock-location fix above is still refused either way: that is the
        // phone reporting the fake, not us inferring it.
        return context.auto ? { ok: true } : verdict;
      }
    }
  }

  return { ok: true };
}

async function recordSuspicion(
  employeeId: number,
  context: { action: string; ip: string | null },
  verdict: TrustVerdict,
): Promise<void> {
  await insertAuditLog({
    action: 'location_rejected',
    entity: 'attendance',
    entity_id: null,
    performed_by: employeeId,
    details: {
      employee_id: employeeId,
      attempted: context.action,
      reason: verdict.reason,
      ...verdict.details,
    },
    ip_address: context.ip,
  });
}
