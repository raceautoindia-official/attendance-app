-- =============================================================================
-- 2026-07-29 — Repair tracking points that predate their session's start
--
-- Phones with a slow clock stamped GPS fixes minutes early, so the admin map
-- showed tracking "before login" and employees were wrongly suspected of
-- misusing the app. A session's started_at_utc is server-stamped, so any point
-- earlier than it is provably a clock artifact — pull those up to the start.
-- The ping API now enforces this on every new point; this fixes history.
--
-- Safe to re-run (idempotent).
-- =============================================================================

UPDATE live_tracking_points p
JOIN live_tracking_sessions s ON s.id = p.session_id
SET p.tracked_at_utc = s.started_at_utc
WHERE p.tracked_at_utc < s.started_at_utc;
