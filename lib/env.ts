/**
 * lib/env.ts — Environment variable validation
 *
 * Import this module at the top of any server-side entrypoint (e.g. lib/db.ts)
 * to catch misconfiguration at startup rather than at runtime inside a request.
 *
 * IMPORTANT: This file must NOT be imported by client components or
 * Edge-runtime code (middleware.ts). It relies on process.env and throws,
 * which is not available in those contexts.
 */

const REQUIRED: readonly string[] = [
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'WEBAUTHN_RP_ID',
  'WEBAUTHN_ORIGIN',
];

// Skip validation during `next build` when env vars are typically not
// available in the build container. At runtime (dev + production) all
// variables must be present.
const isBuildPhase =
  process.env.NEXT_PHASE === 'phase-production-build' ||
  process.env.SKIP_ENV_VALIDATION === '1';

if (!isBuildPhase) {
  const missing = REQUIRED.filter(key => !process.env[key]);

  if (missing.length > 0) {
    const lines = missing.map(k => `  • ${k}`).join('\n');
    throw new Error(
      `[env] Missing required environment variables:\n${lines}\n\n` +
        `Add them to your .env.local file (development) or to your server` +
        ` environment (production). See README.md for the full reference.`,
    );
  }
}
