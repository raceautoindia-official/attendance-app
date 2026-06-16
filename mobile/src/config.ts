// Base URL of your deployed Next.js backend. MUST be https in production
// (Android blocks cleartext http by default, and your auth needs TLS anyway).
// For local testing against a dev machine, use your machine's LAN IP, e.g.
// 'http://192.168.1.50:3001', and enable cleartext in app.json.
// LOCAL TESTING: points at the Next.js dev server on this PC (same Wi-Fi).
// For production, change this to your deployed HTTPS URL, e.g.
// 'https://attendance.yourcompany.com'.
export const API_BASE_URL = 'http://192.168.1.6:3000';

// How often the background task sends a location point, in milliseconds.
export const LOCATION_INTERVAL_MS = 15_000;

// Minimum distance (meters) the device must move before a new point fires.
export const LOCATION_DISTANCE_M = 10;
