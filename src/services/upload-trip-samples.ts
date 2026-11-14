/*
* Receives the samples the app recorded during one trip and saves every
* sample as its own row in trip_data_points. The app sends the whole trip
* once, when the trip ends, oldest first.
*
* App field -> column: timestamp -> recorded_at, speed -> speed_kmh,
* acceleration -> acceleration, latitude -> latitude, longitude -> longitude.
*
* A retry sends the whole trip again; the repository replaces any rows
* already saved, so a retry never leaves duplicates behind.
*
* AB#77: only the signed-in owner of an Active trip can upload to it.
*/
import type { TripSampleRow, UserTripRepository } from '../repositories/user-trip-repository.js';
import type { Trip } from '../types/trip.js';
import type { Authenticate } from './request-auth.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Speed is km/h and acceleration m/s². Speed, latitude and longitude are
// null on motion readings; acceleration is filled on every sample.
interface UploadedSample {
    timestamp: string;
    speed: number | null;
    acceleration: number;
    latitude: number | null;
    longitude: number | null;
}

function isValidSample(sample: unknown): sample is UploadedSample {
    if (typeof sample !== 'object' || sample === null) return false;
    const s = sample as Record<string, unknown>;
    const numberOrNull = (value: unknown) => value === null || typeof value === 'number';
    return typeof s.timestamp === 'string' &&
        !Number.isNaN(Date.parse(s.timestamp)) &&
        typeof s.acceleration === 'number' &&
        numberOrNull(s.speed) &&
        numberOrNull(s.latitude) &&
        numberOrNull(s.longitude);
}

const invalid = (message: string) =>
    Response.json({ error: 'invalid_request', message }, { status: 400 });

export function createUploadTripSamplesHandler(
    authenticate: Authenticate,
    trips: Pick<UserTripRepository, 'findTrip' | 'replaceSamples'>,
) {
    return async function POST(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        let body: { tripId?: unknown; samples?: unknown };
        try {
            body = await request.json();
        } catch {
            return invalid('Request body must be JSON with tripId and samples.');
        }
        const { tripId, samples } = body ?? {};

        if (typeof tripId !== 'string' || !uuidPattern.test(tripId)) {
            return invalid('tripId must be a valid UUID.');
        }
        if (!Array.isArray(samples) || samples.length === 0 || !samples.every(isValidSample)) {
            return invalid('samples must be a non-empty list of samples, each with a timestamp, an acceleration, and speed, latitude and longitude as numbers or null.');
        }

        let trip: Trip | null;
        try {
            trip = await trips.findTrip(auth.access, tripId);
        } catch (error) {
            console.error('Failed to look up trip for upload:', error);
            return Response.json({ error: 'trip_lookup_failed', message: 'Failed to look up the trip.' }, { status: 503 });
        }
        // Someone else's trip is reported exactly like a missing one.
        if (!trip) {
            return Response.json({ error: 'trip_not_found', message: 'Trip not found.' }, { status: 404 });
        }
        // Preserve the exact raw samples associated with stored enrichment and scores.
        if (trip.status !== 'Active') {
            return Response.json({ error: 'trip_not_active', message: 'Samples cannot change after a trip ends.' }, { status: 409 });
        }

        const rows: TripSampleRow[] = (samples as UploadedSample[]).map(sample => ({
            trip_id: tripId,
            recorded_at: sample.timestamp,
            speed_kmh: sample.speed,
            acceleration: sample.acceleration,
            latitude: sample.latitude,
            longitude: sample.longitude,
        }));

        try {
            await trips.replaceSamples(auth.access, tripId, rows);
        } catch (error) {
            console.error('Failed to save trip samples:', error);
            return Response.json({ error: 'samples_upload_failed', message: 'Failed to save the trip samples.' }, { status: 503 });
        }

        return Response.json({ trip_id: tripId, inserted: rows.length }, { status: 201 });
    };
}
