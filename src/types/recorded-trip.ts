import type { RecordedTripSample } from '../services/trip-scoring.js';

export type RecordedTripResult =
    | { status: 'NotFound' }
    | { status: 'NotReady' }
    | { status: 'Unscored'; score: null; reason: 'NO_GPS_READINGS' }
    | { status: 'Ready'; input: { tripId: string; distanceKm: number | null; samples: RecordedTripSample[] } };
