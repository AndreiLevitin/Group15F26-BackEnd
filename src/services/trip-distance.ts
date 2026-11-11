import { gpsDistanceKm } from './gps-distance.ts';

interface GpsPoint {
    recorded_at: string;
    latitude: number | null;
    longitude: number | null;
}

export function calculateTripDistanceKm(points: readonly GpsPoint[]): number | null {
    const byTime = new Map<number, { latitude: number; longitude: number }>();

    for (const { recorded_at, latitude, longitude } of points) {
        const time = Date.parse(recorded_at);
        if (
            !Number.isFinite(time) ||
            typeof latitude !== 'number' ||
            !Number.isFinite(latitude) ||
            Math.abs(latitude) > 90 ||
            typeof longitude !== 'number' ||
            !Number.isFinite(longitude) ||
            Math.abs(longitude) > 180 ||
            byTime.has(time)
        ) {
            continue;
        }
        byTime.set(time, { latitude, longitude });
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
