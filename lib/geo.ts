import { queryOne } from './db';
import type { GeofenceStatus, Location } from './types';

// Earth's mean radius in metres (WGS-84 approximation)
const EARTH_RADIUS_M = 6_371_000;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Haversine formula — returns the great-circle distance between two
 * (lat, lng) pairs in metres.
 *
 * Accuracy is sufficient for geofencing purposes (< 0.5 % error over
 * distances up to a few kilometres).
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Returns true when the employee's coordinates fall within `radiusMeters`
 * of the location's centre point.
 */
export function isWithinGeofence(
  empLat: number,
  empLng: number,
  locationLat: number,
  locationLng: number,
  radiusMeters: number,
): boolean {
  return haversineDistance(empLat, empLng, locationLat, locationLng) <= radiusMeters;
}

/**
 * Resolve the geofence status for an employee clock-in/out event.
 *
 * - Returns `'not_required'` when `locationId` is null/undefined or the
 *   location has geofencing disabled in the DB.
 * - Returns `'inside'` or `'outside'` based on the haversine check.
 * - Returns `'not_required'` if the location row is not found (defensive).
 */
export async function getGeofenceStatus(
  empLat: number,
  empLng: number,
  locationId: number | null | undefined,
): Promise<GeofenceStatus> {
  if (!locationId) return 'not_required';

  const location = await queryOne<Location>(
    'SELECT * FROM locations WHERE id = ? AND is_active = TRUE',
    [locationId],
  );

  if (!location) return 'not_required';

  const inside = isWithinGeofence(
    empLat,
    empLng,
    location.latitude,
    location.longitude,
    location.radius_meters,
  );

  return inside ? 'inside' : 'outside';
}
