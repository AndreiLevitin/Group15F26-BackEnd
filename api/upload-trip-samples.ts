/*
* upload-trip-samples.ts
*
* Receives the samples the app recorded during one trip and
* saves every sample as its own row in trip_data_points.
* The app sends the whole trip once, when the trip ends, in
* the order the samples were recorded, oldest first.
*
* The app's sample fields are timestamp, speed,
* acceleration, latitude and longitude. The table's columns
* are named the way the backend code reads them (see
* database/003_create_trip_data_points.sql), so each sample
* is mapped field to column in this file:
* timestamp -> recorded_at
* speed -> speed_kmh
* acceleration -> acceleration
* latitude -> latitude
* longitude -> longitude
*
* If an upload is retried, the app sends the whole trip
* again. Any rows already saved for the trip are deleted
* first, then the full set is inserted, so a retry can
* never leave duplicate rows behind.
*/

import { supabase } from '../src/lib/supabase.js';

const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One sample as the app sends it. Speed is in km/h and
// acceleration is in m/s squared. Speed, latitude and
// longitude are null on motion readings; acceleration is
// filled on every sample.
interface UploadedSample {
    timestamp: string;
    speed: number | null;
    acceleration: number;
    latitude: number | null;
    longitude: number | null;
}

function isValidSample(sample: unknown): sample is UploadedSample {
    if (typeof sample !== 'object' || sample === null) {
        return false;
    }

    const s = sample as Record<string, unknown>;
    const numberOrNull = (value: unknown) =>
        value === null || typeof value === 'number';

    return (
        typeof s.timestamp === 'string' &&
        !Number.isNaN(Date.parse(s.timestamp)) &&
        typeof s.acceleration === 'number' &&
        numberOrNull(s.speed) &&
        numberOrNull(s.latitude) &&
        numberOrNull(s.longitude)
    );
}

export async function POST(request: Request) {
    let body: { tripId?: unknown; samples?: unknown };

    try {
        body = await request.json();
    } catch {
        return Response.json(
            {
                error: 'invalid_request',
                message:
                    'Request body must be JSON with tripId and samples.',
            },
            { status: 400 },
        );
    }

    const { tripId, samples } = body;

    if (typeof tripId !== 'string' || !uuidPattern.test(tripId)) {
        return Response.json(
            {
                error: 'invalid_request',
                message: 'tripId must be a valid UUID.',
            },
            { status: 400 },
        );
    }

    if (
        !Array.isArray(samples) ||
        samples.length === 0 ||
        !samples.every(isValidSample)
    ) {
        return Response.json(
            {
                error: 'invalid_request',
                message:
                    'samples must be a non-empty list of samples, each with a timestamp, an acceleration, and speed, latitude and longitude as numbers or null.',
            },
            { status: 400 },
        );
    }

    const validSamples = samples as UploadedSample[];

// The trip has to exist before its samples can be saved.
    const { data: trip, error: lookupError } = await supabase
        .from('trips')
        .select('trip_id')
        .eq('trip_id', tripId)
        .maybeSingle();

    if (lookupError) {
        return Response.json(
            {
                error: 'trip_lookup_failed',
                message: 'Failed to look up the trip.',
            },
            { status: 503 },
        );
    }

    if (!trip) {
        return Response.json(
            { error: 'trip_not_found', message: 'Trip not found.' },
            { status: 404 },
        );
    }

// A retry sends the whole trip again, so clear any rows
// already saved for this trip before inserting. The
// trip's samples end up stored exactly once, never twice.
    const { error: deleteError } = await supabase
        .from('trip_data_points')
        .delete()
        .eq('trip_id', tripId);

    if (deleteError) {
        return Response.json(
            {
                error: 'samples_upload_failed',
                message: 'Failed to save the trip samples.',
            },
            { status: 503 },
        );
    }

    const rows = validSamples.map((sample) => ({
        trip_id: tripId,
        recorded_at: sample.timestamp,
        speed_kmh: sample.speed,
        acceleration: sample.acceleration,
        latitude: sample.latitude,
        longitude: sample.longitude,
    }));

    const { error: insertError } = await supabase
        .from('trip_data_points')
        .insert(rows);

    if (insertError) {
        return Response.json(
            {
                error: 'samples_upload_failed',
                message: 'Failed to save the trip samples.',
            },
            { status: 503 },
        );
    }

    return Response.json(
        { trip_id: tripId, inserted: rows.length },
        { status: 201 },
    );
}
