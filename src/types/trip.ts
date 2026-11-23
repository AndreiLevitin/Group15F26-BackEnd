export type TripStatus = 'Active' | 'Processing' | 'Completed' | 'Invalid';
export type PermissionLevel = 'background' | 'foreground' | 'approximate' | 'denied';

export interface Trip {
    trip_id: string;
    start_time: string;
    end_time: string | null;
    status: TripStatus;
    distance_km: number | null;
    trip_score: number | null;
    permission_level: PermissionLevel | null;
}

export interface EndTripRequest {
    tripId: string;
}

export const tripFields =
    // AB#207: the location permission a trip runs under. The app asks
    // before the trip is created and sends the answer with the start.
    'trip_id, start_time, end_time, status, distance_km, trip_score, permission_level';
