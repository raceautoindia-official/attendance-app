// Base URL of your deployed Next.js backend. MUST be https in production
// (Android blocks cleartext http by default, and your auth needs TLS anyway).
// For local testing against a dev machine, use your machine's LAN IP, e.g.
// 'http://192.168.1.50:3001', and enable cleartext in app.json.
// Production backend — the app connects over the internet (stable, works on
// mobile data anywhere). For local testing, swap to your PC's LAN IP, e.g.
// 'http://192.168.1.6:3000'.
export const API_BASE_URL = 'https://attendance.raceinnovations.in';

// How often the background task sends a location point, in milliseconds.
export const LOCATION_INTERVAL_MS = 15_000;

// Minimum distance (meters) the device must move before a new point fires.
// MUST stay 0: on Android this maps to "smallest displacement" on the fused
// location provider — any value > 0 suppresses ALL updates while the phone is
// stationary, so no pings are sent and the server's stale-session monitor
// kills the live session after a few minutes. With 0, updates fire purely on
// LOCATION_INTERVAL_MS and act as a keep-alive heartbeat even when still.
export const LOCATION_DISTANCE_M = 0;

// Points that fail to upload (offline, server hiccup) are kept in memory and
// retried with the next fix, each keeping its ORIGINAL fix time — so a trail
// through a dead zone uploads complete and correctly timestamped when signal
// returns. Capped so an outage can't grow it unbounded; oldest drop first.
//
// 2000 fixes at one per 15 seconds is over eight hours — a full shift spent
// offline arrives intact. (~200 KB of memory at worst; the queue lives as long
// as the tracking service does, which is the same lifetime as the trail.)
export const LOCATION_MAX_QUEUE = 2000;
