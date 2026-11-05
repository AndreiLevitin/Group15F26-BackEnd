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

    const radians = (degrees: number) => degrees * Math.PI / 180;
    let previous: { latitude: number; longitude: number } | undefined;
    let distanceKm = 0;

    for (const [, point] of ordered) {
        if (previous) {
            const dLat = radians(point.latitude - previous.latitude);
            const dLon = radians(point.longitude - previous.longitude);
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(radians(previous.latitude)) *
                Math.cos(radians(point.latitude)) *
                Math.sin(dLon / 2) ** 2;
            distanceKm += 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
        }
        previous = point;
    }

    return distanceKm;
}
