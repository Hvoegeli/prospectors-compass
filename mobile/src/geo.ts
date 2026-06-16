// Field navigation math: how far and which way to a waypoint.
//
// Pure functions over lat/lon degrees — no React, no I/O — so they're trivially
// testable and the component just renders the numbers. Distances use the
// haversine (great-circle) formula; bearings use the initial great-circle
// bearing. Over field ranges (a few miles) flat-earth math would be close, but
// the spherical form is the honest, reusable one and costs nothing here.

const EARTH_RADIUS_M = 6371000 // mean Earth radius, meters
const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.28084

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI

/** Great-circle distance between two lat/lon points, in meters. */
export function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const φ1 = toRad(aLat)
  const φ2 = toRad(bLat)
  const dφ = toRad(bLat - aLat)
  const dλ = toRad(bLon - aLon)
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  // clamp to 1 to guard against tiny floating-point overshoot before asin
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial great-circle bearing FROM point A TO point B, in degrees clockwise
 *  from true north (0–360). This is the compass direction to start walking. */
export function bearingDegrees(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const φ1 = toRad(aLat)
  const φ2 = toRad(bLat)
  const dλ = toRad(bLon - aLon)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360 // normalize atan2's -180..180 to 0..360
}

const COMPASS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]

/** A 0–360 bearing → its 16-point compass abbreviation (e.g. 312 → "NW"). */
export function cardinal16(deg: number): string {
  // 360 / 16 = 22.5° per sector; round to the nearest sector, wrap at 16.
  return COMPASS_16[Math.round(deg / 22.5) % 16]
}

/** A distance in meters → a field-friendly imperial string. Shows feet under a
 *  tenth of a mile (rounded to 10 ft so it doesn't overstate GPS precision),
 *  miles beyond that. */
export function formatDistanceImperial(meters: number): string {
  const miles = meters / METERS_PER_MILE
  if (miles < 0.1) {
    const feet = Math.round((meters * FEET_PER_METER) / 10) * 10
    return `${feet} ft`
  }
  if (miles < 10) return `${miles.toFixed(2)} mi`
  return `${miles.toFixed(1)} mi`
}
