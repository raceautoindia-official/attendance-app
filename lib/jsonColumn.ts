/**
 * Read a JSON column (audit_log.details and friends) into a plain object.
 *
 * mysql2 hands a JSON column back ALREADY PARSED as an object on this pool, and
 * as a string on other server/driver combinations. Calling JSON.parse() on the
 * object throws — and every caller wrapped that in a try/catch, so the throw was
 * silent and the details simply came out EMPTY. It has been found twice in
 * production: once labelling every fence-closed session 'manual', once stripping
 * the reason and the map pin off every event in the day timeline. Nothing looks
 * broken when this happens, which is exactly why it needs one shared reader.
 *
 * Returns {} for null, for a malformed string, and for anything that is not an
 * object — a missing detail is always read as "not recorded", never as a throw
 * inside a clock-in.
 *
 * It lives here rather than in lib/db so it can be read without opening a
 * connection pool: db.ts creates one at import time, which puts every pure
 * helper inside it out of reach of a test.
 */
export function readJsonColumn(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
