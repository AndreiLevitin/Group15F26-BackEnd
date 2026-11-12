import { gpsDistanceKm } from './gps-distance.ts';
import { hasValidCoordinates, gpsTimestampMillis } from './gps-validation.ts';

interface GpsPoint {
    recorded_at: string;
    latitude: number | null;
    longitude: number | null;
}

export function calculateTripDistanceKm(points: readonly GpsPoint[]): number | null {
    const byTime = new Map<number, { latitude: number; longitude: number }>();

    for (const point of points) {
        const time = gpsTimestampMillis(point.recorded_at);
        if (
            !Number.isFinite(time) ||
            !hasValidCoordinates(point) ||
            byTime.has(time)
        ) {
            continue;
        }
        byTime.set(time, { latitude: point.latitude, longitude: point.longitude });
    }

    const ordered = [...byTime.entries()].sort(([a], [b]) => a - b);
    if (ordered.length < 2) return null;

    let previous: { latitude: number; longitude: number } | undefined;
    let distanceKm = 0;

    for (const [, point] of ordered) {
        if (previous) {
            distanceKm += gpsDistanceKm(previous, point);
        }
        previous = point;
    }

    return distanceKm;
}
