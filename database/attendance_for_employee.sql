-- =============================================================================
-- ATTENDANCE FOR ONE EMPLOYEE
--
--   mysql -u <user> -p <database> < database/attendance_for_employee.sql
--
-- Change the two settings below. Matching is on name OR emp_id and is partial,
-- so 'reena' finds "Reena Evanjaline" whatever the full spelling turns out to
-- be. Times are shown in IST; the database stores UTC.
-- =============================================================================

SET @who   := 'reena';        -- <<< name or emp_id, partial match
SET @from  := '2026-08-01';   -- <<< period start
SET @to    := '2026-08-31';   -- <<< period end


-- 0. WHICH EMPLOYEE MATCHED ---------------------------------------------------
-- If this returns more than one row, make @who more specific — every section
-- below covers all matches.
SELECT id, emp_id, name, role,
       IF(is_active, 'active', 'INACTIVE')                       AS status,
       work_mode,
       IF(live_tracking_enabled, 'on', 'OFF')                    AS tracking,
       IF(allow_multiple_sessions, 'allowed', 'single only')     AS multi_login
FROM employees
WHERE name LIKE CONCAT('%', @who, '%') OR emp_id LIKE CONCAT('%', @who, '%');


-- 1. DAY BY DAY ---------------------------------------------------------------
-- worked_hm is what they actually did. required_hm is what the day asked for
-- (both shifts, if two). extra_hm is the time beyond that — overtime.
SELECT
  e.emp_id,
  DATE_FORMAT(a.work_date, '%d-%m-%Y')                              AS work_date,
  DATE_FORMAT(a.work_date, '%a')                                    AS day,
  a.status,
  DATE_FORMAT(CONVERT_TZ(a.clock_in_utc,  '+00:00','+05:30'), '%H:%i') AS in_ist,
  DATE_FORMAT(CONVERT_TZ(a.clock_out_utc, '+00:00','+05:30'), '%H:%i') AS out_ist,
  -- Sessions only mean something on a day that was actually worked.
  IF(a.clock_in_utc IS NULL, NULL, a.session_count)                 AS sessions,
  -- CAST to an integer before formatting: required minutes come from a SUM
  -- over DECIMAL columns, and LPAD on "0.0000" truncates to "0." instead of
  -- padding to "00".
  CONCAT(FLOOR(CAST(COALESCE(a.total_minutes,0) AS SIGNED)/60), 'h ',
         LPAD(MOD(CAST(COALESCE(a.total_minutes,0) AS SIGNED),60),2,'0'), 'm')   AS worked_hm,
  CONCAT(FLOOR(CAST(req.minutes AS SIGNED)/60), 'h ',
         LPAD(MOD(CAST(req.minutes AS SIGNED),60),2,'0'), 'm')                   AS required_hm,
  CONCAT(FLOOR(GREATEST(0, CAST(COALESCE(a.total_minutes,0) - req.minutes AS SIGNED))/60), 'h ',
         LPAD(MOD(GREATEST(0, CAST(COALESCE(a.total_minutes,0) - req.minutes AS SIGNED)),60),2,'0'), 'm')
                                                                    AS extra_hm,
  COALESCE(perm.minutes, 0)                                         AS permission_min,
  a.geofence_status,
  IF(a.edited_by IS NOT NULL, 'edited by admin', '')                AS note
FROM attendance a
JOIN employees e ON e.id = a.employee_id
-- Minutes the day required: every DISTINCT shift in force that works that
-- weekday. Two rows for the same shift count once; a shift that does not work
-- that weekday counts zero.
JOIN LATERAL (
  SELECT COALESCE(SUM(
    COALESCE(s.required_hours * 60,
             NULLIF(MOD(TIME_TO_SEC(TIMEDIFF(s.end_time, s.start_time))/60 + 1440, 1440), 0),
             540)), 0) AS minutes
  FROM shifts s
  WHERE s.id IN (
    SELECT es.shift_id FROM employee_schedules es
    WHERE es.employee_id = a.employee_id
      AND es.effective_from <= a.work_date
      AND (es.effective_to IS NULL OR es.effective_to >= a.work_date)
      AND (s.working_days IS NULL
           OR JSON_CONTAINS(s.working_days,
                JSON_QUOTE(ELT(DAYOFWEEK(a.work_date),'Sun','Mon','Tue','Wed','Thu','Fri','Sat'))))
  )
) req ON TRUE
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(pr.minutes),0) AS minutes
  FROM permission_requests pr
  WHERE pr.employee_id = a.employee_id
    AND pr.permission_date = a.work_date
    AND pr.status = 'approved'
) perm ON TRUE
WHERE (e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND a.work_date BETWEEN @from AND @to
ORDER BY a.work_date;


-- 2. PERIOD TOTAL -------------------------------------------------------------
SELECT
  e.emp_id, e.name,
  COUNT(*)                                                          AS days_recorded,
  SUM(a.status = 'present')                                         AS present,
  SUM(a.status = 'late')                                            AS late,
  SUM(a.status = 'absent')                                          AS absent,
  SUM(a.status IN ('leave','holiday'))                              AS leave_or_holiday,
  CONCAT(FLOOR(CAST(SUM(COALESCE(a.total_minutes,0)) AS SIGNED)/60), 'h ',
         LPAD(MOD(CAST(SUM(COALESCE(a.total_minutes,0)) AS SIGNED),60),2,'0'), 'm') AS total_worked
FROM attendance a
JOIN employees e ON e.id = a.employee_id
WHERE (e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND a.work_date BETWEEN @from AND @to
GROUP BY e.id, e.emp_id, e.name;


-- 3. WHAT THEY ARE ROSTERED ON ------------------------------------------------
-- More than one row here is a double shift. 'NO LOCATION' or geofencing off
-- explains why away-from-site auto clock-out never fires for them.
SELECT e.emp_id, s.name AS shift, s.type,
       TIME_FORMAT(s.start_time,'%H:%i')                           AS starts,
       TIME_FORMAT(s.end_time,'%H:%i')                             AS ends,
       s.working_days,
       COALESCE(l.name,'NO LOCATION')                              AS location,
       IF(es.geofencing_enabled,'on','OFF')                        AS geofence,
       DATE_FORMAT(es.effective_from,'%d-%m-%Y')                   AS from_date
FROM employee_schedules es
JOIN employees e ON e.id = es.employee_id
JOIN shifts s ON s.id = es.shift_id
LEFT JOIN locations l ON l.id = es.location_id
WHERE (e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
ORDER BY s.start_time;


-- 4. AUTOMATIC ACTIONS ON THIS EMPLOYEE ---------------------------------------
-- Why a day looks the way it does: auto clock-out, away-from-site, marked
-- absent, refused location, refused device.
SELECT DATE_FORMAT(CONVERT_TZ(al.created_at,'+00:00','+05:30'), '%d-%m-%Y %H:%i') AS when_ist,
       al.action,
       JSON_UNQUOTE(JSON_EXTRACT(al.details,'$.reason'))           AS reason,
       JSON_UNQUOTE(JSON_EXTRACT(al.details,'$.work_date'))        AS work_date,
       JSON_UNQUOTE(JSON_EXTRACT(al.details,'$.credited_minutes')) AS credited_min
FROM audit_log al
JOIN employees e ON e.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(al.details,'$.employee_id')) AS UNSIGNED)
WHERE (e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND al.action IN ('session_auto_closed','geofence_auto_clockout','marked_absent',
                    'location_rejected','device_rejected','session_continued_across_day')
ORDER BY al.created_at DESC
LIMIT 30;
