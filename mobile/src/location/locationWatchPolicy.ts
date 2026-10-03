// The location-off enforcement rule, kept free of expo/native imports so it can
// be reasoned about — and tested — on its own.
//
//   warning 1 of 4 → 2 of 4 → 3 of 4 → 4 of 4 (final) → automatic clock-out
//
// Every step waits at least STRIKE_SPACING_MIN since the previous one, so the
// employee gets the same grace after the final warning as after every earlier
// one. Location coming back resets the count to zero (handled by the caller).

/** Warning notifications delivered before the automatic clock-out. */
export const MAX_WARNINGS = 4;

/** Minimum gap between consecutive warnings, and before the clock-out. */
export const STRIKE_SPACING_MIN = 10;

export type LocationAction =
  | { action: 'wait' }
  | { action: 'warn'; warningNumber: number; isFinal: boolean }
  | { action: 'clock_out' };

/**
 * Decide what a failed location check should do.
 *
 * @param warnings warnings already delivered this run (0 on a clean slate)
 * @param lastMs   epoch ms of the previous warning (0 when none yet)
 * @param nowMs    current epoch ms
 */
export function decideLocationAction(
  warnings: number,
  lastMs: number,
  nowMs: number,
): LocationAction {
  const spacingElapsed = nowMs - lastMs >= STRIKE_SPACING_MIN * 60_000;

  // All warnings sent — clock out once the grace period after the final
  // warning has passed. A failed clock-out leaves the counter and timestamp
  // untouched, so the next check retries immediately.
  if (warnings >= MAX_WARNINGS) {
    return spacingElapsed ? { action: 'clock_out' } : { action: 'wait' };
  }

  if (!spacingElapsed) return { action: 'wait' };

  const warningNumber = warnings + 1;
  return { action: 'warn', warningNumber, isFinal: warningNumber === MAX_WARNINGS };
}
