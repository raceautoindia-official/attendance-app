-- =============================================================================
-- TRACKING GAPS — turn "sometimes it doesn't work" into named minutes
--
--   cd ~/attendance-app && mysql --table -u "$(grep -m1 '^DB_USER=' .env | cut -d= -f2-)" -p"$(grep -m1 '^DB_PASSWORD=' .env | cut -d= -f2-)" "$(grep -m1 '^DB_NAME=' .env | cut -d= -f2-)" < database/tracking_gaps.sql
--
-- Two tables for the chosen work day:
--   1. per employee: how much of their ON-SHIFT time was actually covered by
--      fixes, as a percentage;
--   2. every gap longer than @gap_min minutes, with start, end and duration.
--
-- HOW TO READ A GAP — this is the part that settles arguments:
-- a phone that is merely OFFLINE keeps sampling and uploads the backlog with
-- the ORIGINAL timestamps when signal returns, so offline time fills itself in
-- and leaves no gap here. A gap that persists in this report means the app was
-- NOT SAMPLING during those minutes: the OS killed it, battery management
-- suspended it, or location was switched off. Every gap below is therefore a
-- handset fact, not a network excuse — and the location-off warnings /
-- fence-exit escalation are what act on it live.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The work day to examine (07:00 IST boundaries). Default: the current one.
SET @day := DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'), INTERVAL 7 HOUR));
SET @ws  := CONVERT_TZ(CONCAT(@day, ' 07:00:00'), '+05:30', '+00:00');
SET @we  := CONVERT_TZ(CONCAT(DATE_ADD(@day, INTERVAL 1 DAY), ' 07:00:00'), '+05:30', '+00:00');

-- A pause this long or longer counts as a gap. The app samples every 30
-- seconds, so 10 minutes of silence is ~20 consecutive missing fixes.
SET @gap_min := 10;

-- 1. COVERAGE PER PERSON -------------------------------------------------------
SELECT
  e.emp_id,
  e.name,
  CONVERT_TZ(GREATEST(COALESCE(a.first_clock_in_utc, a.clock_in_utc), @ws), '+00:00', '+05:30') AS shift_from_ist,
  CONVERT_TZ(LEAST(COALESCE(a.clock_out_utc, UTC_TIMESTAMP()), @we), '+00:00', '+05:30')        AS shift_to_ist,
  TIMESTAMPDIFF(MINUTE,
    GREATEST(COALESCE(a.first_clock_in_utc, a.clock_in_utc), @ws),
    LEAST(COALESCE(a.clock_out_utc, UTC_TIMESTAMP()), @we))                                     AS shift_min,
  COALESCE(p.n, 0)                                                                              AS fixes,
  -- Healthy is 2 fixes per minute of shift; 100% means the phone never slept.
  LEAST(100, ROUND(100 * COALESCE(p.n, 0) /
    GREATEST(1, 2 * TIMESTAMPDIFF(MINUTE,
      GREATEST(COALESCE(a.first_clock_in_utc, a.clock_in_utc), @ws),
      LEAST(COALESCE(a.clock_out_utc, UTC_TIMESTAMP()), @we)))))                                AS coverage_pct
FROM attendance a
JOIN employees e ON e.id = a.employee_id
LEFT JOIN (
  SELECT employee_id, COUNT(*) AS n
  FROM live_tracking_points
  WHERE tracked_at_utc >= @ws AND tracked_at_utc < @we
  GROUP BY employee_id
) p ON p.employee_id = a.employee_id
WHERE a.work_date = @day
  AND a.clock_in_utc IS NOT NULL
ORDER BY coverage_pct ASC, e.emp_id;

-- 2. THE GAPS THEMSELVES -------------------------------------------------------
-- Consecutive fixes more than @gap_min apart, inside the day window. The first
-- fix after a clock-in has no predecessor, so the stretch between clock-in and
-- the first fix is measured against the clock-in itself.
WITH seq AS (
  SELECT employee_id, tracked_at_utc,
         LAG(tracked_at_utc) OVER (PARTITION BY employee_id ORDER BY tracked_at_utc, id) AS prev_utc
  FROM live_tracking_points
  WHERE tracked_at_utc >= @ws AND tracked_at_utc < @we
)
SELECT e.emp_id, e.name,
       CONVERT_TZ(s.prev_utc, '+00:00', '+05:30')        AS silent_from_ist,
       CONVERT_TZ(s.tracked_at_utc, '+00:00', '+05:30')  AS silent_until_ist,
       TIMESTAMPDIFF(MINUTE, s.prev_utc, s.tracked_at_utc) AS gap_min,
       'app was not sampling — killed/suspended/location off (offline self-fills and would not show here)' AS meaning
FROM seq s
JOIN employees e ON e.id = s.employee_id
WHERE s.prev_utc IS NOT NULL
  AND TIMESTAMPDIFF(MINUTE, s.prev_utc, s.tracked_at_utc) >= @gap_min
ORDER BY gap_min DESC, e.emp_id
LIMIT 50;
