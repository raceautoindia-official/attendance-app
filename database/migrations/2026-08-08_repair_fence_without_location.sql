-- ---------------------------------------------------------------------------
-- Stop schedules claiming a fence they do not have.
--
-- geofencing_enabled = TRUE with location_id = NULL read as "fenced" in the
-- admin UI while the clock-in check skipped the fence entirely — so those
-- employees could clock in from anywhere, and nothing on screen said so.
--
-- Assigning a schedule now refuses that combination outright, and the clock-in
-- route refuses to proceed if it ever occurs again (rather than waving it
-- through). This clears the rows that pre-date those checks, so the flag now
-- matches what is actually enforced. Nobody loses a fence they really had:
-- these schedules never had one.
--
-- To give these employees a real fence, reassign the schedule WITH a location.
-- ---------------------------------------------------------------------------

UPDATE employee_schedules
SET geofencing_enabled = FALSE
WHERE geofencing_enabled = TRUE
  AND location_id IS NULL;
