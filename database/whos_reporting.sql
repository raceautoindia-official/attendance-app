-- =============================================================================
-- WHO IS ACTUALLY REPORTING — the live-tracking health check
--
--   cd ~/attendance-app && mysql --table -u "$(grep -m1 '^DB_USER=' .env | cut -d= -f2-)" -p"$(grep -m1 '^DB_PASSWORD=' .env | cut -d= -f2-)" "$(grep -m1 '^DB_NAME=' .env | cut -d= -f2-)" < database/whos_reporting.sql
--
-- One row per clocked-in employee, ending in a verdict that says what (if
-- anything) to do about their phone. Run it whenever the Live Tracking page
-- looks wrong: it separates "phone not sending" (a handset problem no server
-- change can fix) from "sending badly" from "all fine, the page is wrong".
--
-- A healthy phone sends a fix every 30 seconds: ~20 in 10 minutes.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SELECT
  e.emp_id,
  e.name,
  IF(s.id IS NULL, 'no session', 'active')                            AS session,
  COALESCE(pts.n_10min, 0)                                            AS pts_10min,
  COALESCE(CONCAT(TIMESTAMPDIFF(MINUTE, pts.newest, UTC_TIMESTAMP()), ' min ago'),
           'NEVER')                                                   AS last_fix,
  pts.avg_acc_30min                                                   AS avg_acc_m,
  CASE
    WHEN pts.newest IS NULL
      THEN 'PHONE: never sent — install APK, Allow all the time, battery Unrestricted, mobile data'
    WHEN COALESCE(pts.n_10min, 0) = 0
      THEN 'PHONE: stopped — open the app once; if still dead, check battery/data settings'
    WHEN COALESCE(pts.n_10min, 0) < 8
      THEN 'PHONE: throttled — sending, but Android is suspending it (battery optimisation)'
    WHEN pts.avg_acc_30min > 100
      THEN 'SIGNAL: sending fine but fixes are imprecise (indoors/vehicle) — map may hide them'
    ELSE 'OK — reporting at full rate'
  END                                                                 AS verdict
FROM attendance a
JOIN employees e ON e.id = a.employee_id
LEFT JOIN live_tracking_sessions s
  ON s.employee_id = e.id AND s.is_active = TRUE
LEFT JOIN (
  SELECT employee_id,
         SUM(tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)) AS n_10min,
         MAX(tracked_at_utc)                                                  AS newest,
         ROUND(AVG(CASE WHEN tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)
                        THEN accuracy_meters END))                            AS avg_acc_30min
  FROM live_tracking_points
  WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
  GROUP BY employee_id
) pts ON pts.employee_id = e.id
WHERE a.clock_in_utc IS NOT NULL
  AND a.clock_out_utc IS NULL
ORDER BY COALESCE(pts.n_10min, 0) DESC, e.emp_id;

-- The fleet in one line: how many of the clocked-in are actually being heard.
SELECT COUNT(*)                                                   AS clocked_in,
       SUM(EXISTS (SELECT 1 FROM live_tracking_points p
                    WHERE p.employee_id = a.employee_id
                      AND p.tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)))
                                                                  AS reporting_now
FROM attendance a
WHERE a.clock_in_utc IS NOT NULL AND a.clock_out_utc IS NULL;
