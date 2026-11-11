import type { SpeedLimitSample } from '../types/speed-limit.js';

export function gpsDistanceKm(a: SpeedLimitSample, b: SpeedLimitSample): number {
    const radians = (v: number) => v * Math.PI / 180;
    const lat = radians(b.latitude - a.latitude);
    const lon = radians(b.longitude - a.longitude);
    const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.latitude)) *
        Math.cos(radians(b.latitude)) * Math.sin(lon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Straight-line distance is an estimate; actual matched-distance caps are checked separately. */
export function chunkSpeedLimitTrace(
    samples: readonly SpeedLimitSample[],
    maxPoints = 4900,
    maxDistanceKm = 80,
): SpeedLimitSample[][] {
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 5000 ||
        !Number.isFinite(maxDistanceKm) || maxDistanceKm <= 0 || maxDistanceKm >= 100) {
        throw new Error('Invalid trace chunk limits.');
    }
    const chunks: SpeedLimitSample[][] = [];
    let chunk: SpeedLimitSample[] = [];
    let distance = 0;
    for (const point of samples) {
        const previous = chunk.at(-1);
        const leg = previous ? gpsDistanceKm(previous, point) : 0;
        // TomTom permits at most 6 km road distance between consecutive points.
        // Split obvious GPS gaps rather than routing across them.
        if (previous && leg >= 5) {
            chunks.push(chunk);
            chunk = [point];
            distance = 0;
        } else if (previous && (chunk.length >= maxPoints || distance + leg > maxDistanceKm)) {
            chunks.push(chunk);
            chunk = [previous, point]; // One point of context; merged by sampleId.
            distance = leg;
        } else {
            chunk.push(point);
            distance += leg;
        }
    }
    if (chunk.length) chunks.push(chunk);
    return chunks;
}
