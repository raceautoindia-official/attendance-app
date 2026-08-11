// The away-from-site enforcement rule, kept free of expo/native imports so it
// can be reasoned about — and tested — on its own. Same shape as
// locationWatchPolicy, tuned for a different offence:
//
//   warning 1 of 4 → 2 of 4 → 3 of 4 → 4 of 4 (final) → automatic clock-out
//
// Location OFF gets 10-minute spacing, because the remedy is a settings toggle
// someone may not notice for a while. Walking OUT of the fence gets 1-minute
// spacing: the person is moving, knows they are moving, and every minute of
// delay is a minute of paid time off site. Four warnings a minute apart and
// then the clock-out — about four minutes from leaving to being off the clock,
// with four chances to turn around.
//
// Coming back inside the fence at any point resets the count to zero (handled
// by the caller), and the day never closes at all — a quick errand to the car
// no longer costs a session.

/** Warning notifications delivered before the automatic clock-out. */
export const EXIT_MAX_WARNINGS = 4;

/** Minimum gap between consecutive warnings, and before the clock-out. */
export const EXIT_SPACING_MIN = 1;

export type FenceExitAction =
  | { action: 'wait' }
  | { action: 'warn'; warningNumber: number; isFinal: boolean }
  | { action: 'clock_out' };

/**
 * Decide what an outside-the-fence check should do.
 *
 * @param warnings warnings already delivered this excursion (0 on a clean slate)
 * @param lastMs   epoch ms of the previous warning (0 when none yet)
 * @param nowMs    current epoch ms
 */
export function decideFenceExitAction(
  warnings: number,
  lastMs: number,
  nowMs: number,
): FenceExitAction {
  const spacingElapsed = nowMs - lastMs >= EXIT_SPACING_MIN * 60_000;

  // All warnings sent — clock out once the same gap has passed after the final
  // warning, so the last chance is as real as the first. A failed clock-out
  // leaves the counter and timestamp untouched, and the next check retries.
  if (warnings >= EXIT_MAX_WARNINGS) {
    return spacingElapsed ? { action: 'clock_out' } : { action: 'wait' };
  }

  if (!spacingElapsed) return { action: 'wait' };

  const warningNumber = warnings + 1;
  return { action: 'warn', warningNumber, isFinal: warningNumber === EXIT_MAX_WARNINGS };
}
