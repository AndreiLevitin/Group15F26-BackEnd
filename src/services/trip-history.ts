import type { Trip } from '../types/trip.js';

export interface TripHistoryItem {
    tripId: string;
    startTime: string;
    endTime: string | null;
    durationSeconds: number | null;
    distanceKm: number | null;
    status: Trip['status'];
    score: number | null;
    reason: string | null;
}

// Receives only trips belonging to the authenticated user.
// Authentication and ownership filtering belong before this step.
export function buildTripHistory(
    trips: readonly Trip[],
): TripHistoryItem[] {
    return [...trips]
        .sort((a, b) =>
            Date.parse(b.start_time) - Date.parse(a.start_time) ||
            a.trip_id.localeCompare(b.trip_id),
        )
        .map((trip) => {
            const start = Date.parse(trip.start_time);
            const end = trip.end_time === null
                ? NaN
                : Date.parse(trip.end_time);

            const durationSeconds =
                Number.isFinite(start) &&
                Number.isFinite(end) &&
                end >= start
                    ? Math.round((end - start) / 1000)
                    : null;

            return {
                tripId: trip.trip_id,
                startTime: trip.start_time,
                endTime: trip.end_time,
                durationSeconds,
                distanceKm: trip.distance_km,
                status: trip.status,
                score: trip.status === 'Completed'
                    ? trip.trip_score
                    : null,
                reason: trip.status === 'Completed' &&
                    trip.trip_score === null
                        ? 'unscored'
                        : null,
            };
        });
}
