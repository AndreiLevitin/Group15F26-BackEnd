export type TripStatus = 'Active' | 'Processing' | 'Completed' | 'Invalid';

export interface Trip {
    trip_id: string;
    start_time: string;
    end_time: string | null;
    status: TripStatus;
    distance_km: number | null;
    trip_score: number | null;
}

export interface EndTripRequest {
    tripId: string;
}

export const tripFields =
    'trip_id, start_time, end_time, status, distance_km, trip_score';
