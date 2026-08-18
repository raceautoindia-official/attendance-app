// ---------------------------------------------------------------------------
// What a day with no clock-out is worth.
//
// This is the ONE rule, kept as a pure function on purpose. The nightly sweep
// applies it going forward and scripts/repair-attendance.js applies it to
// history, so a day settled last month and a day settled tonight are settled
// the same way. Two implementations of this would mean the reports disagree
// with themselves depending on when a row happened to be written, which is the
// thing that made the old figures impossible to defend.
//
// No database access, no clock reading: everything it needs is an argument, so
// it can be tested exhaustively and re-run over the past without surprises.
// ---------------------------------------------------------------------------

/** Where the credited time came from. Recorded on every audit entry. */
export type SettlementBasis =
  /** A real live-tracking fix: the phone reported from site until it stopped. */
  | 'last_tracked_position'
  /** No fix at all — credited a normal day's length for this employee. */
  | 'scheduled_day_length'
  /** No fix and no roster — the work day's own 07:00 boundary. */
  | 'day_boundary'
  /** Held down by AUTO_CLOSE_MAX_HOURS. */
  | 'capped_at_max_hours';

export interface SettlementInput {
  /** When they clocked in. */
  clockIn: Date;
  /** 07:00 IST at the end of this work day — nobody is credited past it. */
  boundary: Date;
  /** Last position their phone reported after clocking in, if any. */
  lastFix?: Date | null;
  /** A normal day's length for them, in minutes. 0/null when unrostered. */
  requiredMinutes?: number | null;
  /** Ceiling from AUTO_CLOSE_MAX_HOURS, in minutes. Null means none. */
  capMinutes?: number | null;
  /** "Now", for a day still in progress. Defaults to the boundary. */
  now?: Date;
}

export interface Settlement {
  /** The clock-out to store. */
  endAt: Date;
  /** Minutes worked in THIS session (banked minutes are added by the caller). */
  minutes: number;
  basis: SettlementBasis;
}

/**
 * Settle a session that was never clocked out.
 *
 * Ordered by how good the evidence is:
 *
 *   1. the last tracked position — an observation, not an assumption;
 *   2. a normal day's length — the reading that says "they worked their day
 *      and forgot to tap the button", which is what actually happens;
 *   3. the boundary — the only thing left when there is neither.
 *
 * Elapsed-time-to-the-boundary used to be step one, which credited somebody who
 * walked out at six with twenty-two hours.
 */
export function settleSession(input: SettlementInput): Settlement {
  const { clockIn, boundary, lastFix = null, requiredMinutes = null, capMinutes = null } = input;

  // A day still in progress is settled at "now"; a finished one at its boundary.
  const ceilingMs = Math.min(boundary.getTime(), (input.now ?? boundary).getTime());
  const ceiling = new Date(ceilingMs);

  let endAt: Date;
  let basis: SettlementBasis;

  if (lastFix && lastFix.getTime() > clockIn.getTime()) {
    endAt = new Date(lastFix.getTime());
    basis = 'last_tracked_position';
  } else {
    const required = Number(requiredMinutes ?? 0);
    if (required > 0) {
      endAt = new Date(clockIn.getTime() + required * 60_000);
      basis = 'scheduled_day_length';
    } else {
      endAt = ceiling;
      basis = 'day_boundary';
    }
  }

  // Never credited into the day that follows.
  if (endAt.getTime() > ceilingMs) {
    endAt = ceiling;
    basis = 'day_boundary';
  }

  if (capMinutes != null && capMinutes >= 0) {
    const capped = clockIn.getTime() + capMinutes * 60_000;
    if (capped < endAt.getTime()) {
      endAt = new Date(capped);
      basis = 'capped_at_max_hours';
    }
  }

  // Guards a row whose clock-in somehow sits after its own boundary.
  if (endAt.getTime() < clockIn.getTime()) endAt = new Date(clockIn.getTime());

  return {
    endAt,
    minutes: Math.max(0, Math.round((endAt.getTime() - clockIn.getTime()) / 60_000)),
    basis,
  };
}
