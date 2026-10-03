// Base URL of your deployed Next.js backend. MUST be https in production
// (Android blocks cleartext http by default, and your auth needs TLS anyway).
// For local testing against a dev machine, use your machine's LAN IP, e.g.
// 'http://192.168.1.50:3001', and enable cleartext in app.json.
// Production backend — the app connects over the internet (stable, works on
// mobile data anywhere). For local testing, swap to your PC's LAN IP, e.g.
// 'http://192.168.1.6:3000'.
//
// CHANGING THIS STRANDS EVERY PHONE THAT HAS NOT UPDATED.
//
// The address is compiled into the APK, so an employee still on an older
// build keeps asking for the OLD host forever. Keep the previous name
// (attendance.raceinnovations.in) resolving to the same server, and listed in
// nginx's server_name, until every phone is on a build carrying the new one.
// Retiring the old record is what turns "some people have not updated yet"
// into "some people cannot clock in".
export const API_BASE_URL = 'https://worklens.raceinnovations.in';

// How often the background task samples a location fix, in milliseconds.
//
// This number IS the battery bill. Continuous GPS is among the hungriest
// things a phone does, and it runs for the whole shift — at 15 seconds the
// fleet's universal complaint was drain. 30 seconds halves the GPS duty cycle
// while every consumer keeps its guarantee with room to spare:
//   - fence-exit warnings space at 1/minute → still checked twice a minute;
//   - the 10-minute presence grace → still ~20 chances to confirm;
//   - the map's numbered trail buckets by minute → unchanged;
//   - the "Live" indicator allows 2 minutes → unchanged.
// Do not "optimise" this back down without pricing the battery again, and do
// not raise it past 60s — the warning cadence needs at least one fix a minute.
export const LOCATION_INTERVAL_MS = 30_000;

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
