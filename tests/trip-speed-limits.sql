-- Run AFTER migrations 001–004 in a disposable/test Supabase SQL editor as owner.
-- Exercises actual functions/constraints; all inserted rows roll back.
BEGIN;
DO $$
DECLARE
    trip UUID := gen_random_uuid();
    s1 UUID := gen_random_uuid();
    s2 UUID := gen_random_uuid();
    token1 UUID := gen_random_uuid();
    token2 UUID := gen_random_uuid();
    trace JSONB;
    limits JSONB;
    result TEXT;
BEGIN
    INSERT INTO public.trips(trip_id) VALUES (trip);
    INSERT INTO public.trip_data_points(sample_id, trip_id, recorded_at, acceleration, latitude, longitude)
        VALUES (s1, trip, '2026-11-11T12:00:00Z', 0, 43, -80),
               (s2, trip, '2026-11-11T12:00:01Z', 0, 43.001, -80);
    trace := jsonb_build_array(
        jsonb_build_object('sampleId', s1, 'recordedAt', '2026-11-11T12:00:00Z', 'latitude', 43, 'longitude', -80),
        jsonb_build_object('sampleId', s2, 'recordedAt', '2026-11-11T12:00:01Z', 'latitude', 43.001, 'longitude', -80));
    limits := jsonb_build_array(
        jsonb_build_object('sampleId', s1, 'speedLimitKmh', 50, 'status', 'available', 'provider', 'tomtom',
            'fetchedAt', '2026-11-11T12:01:00Z', 'providerSegmentId', 'road'),
        jsonb_build_object('sampleId', s2, 'speedLimitKmh', null, 'status', 'missing', 'provider', 'tomtom',
            'fetchedAt', '2026-11-11T12:01:00Z', 'providerSegmentId', 'road2'));
    BEGIN
        PERFORM public.claim_trip_speed_limits(trip, 'hash', 'tomtom', token1);
        RAISE EXCEPTION 'TEST: active trips must not be enriched';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF;
    END;
    UPDATE public.trips SET status = 'Processing', end_time = now() WHERE trip_id = trip;
    BEGIN
        UPDATE public.trip_data_points SET latitude = 44 WHERE sample_id = s1;
        RAISE EXCEPTION 'TEST: ended raw samples must be immutable';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF;
    END;
    result := public.claim_trip_speed_limits(trip, 'hash', 'tomtom', token1);
    IF result <> 'claimed' THEN RAISE EXCEPTION 'TEST: expected claim'; END IF;
    result := public.claim_trip_speed_limits(trip, 'hash', 'tomtom', token2);
    IF result <> 'busy' THEN RAISE EXCEPTION 'TEST: second request must be busy'; END IF;
    BEGIN
        PERFORM public.complete_trip_speed_limits(trip, token1, trace, jsonb_build_array(limits->0));
        RAISE EXCEPTION 'TEST: partial limits must fail';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.trip_sample_speed_limits WHERE trip_id = trip) THEN
        RAISE EXCEPTION 'TEST: partial rows were persisted';
    END IF;
    BEGIN
        PERFORM public.complete_trip_speed_limits(trip, token2, trace, limits);
        RAISE EXCEPTION 'TEST: wrong lease token must fail';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.complete_trip_speed_limits(trip, token1,
            jsonb_set(trace, '{0,latitude}', '44'), limits);
        RAISE EXCEPTION 'TEST: changed source coordinates must fail';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF;
    END;
    PERFORM public.complete_trip_speed_limits(trip, token1, trace, limits);
    IF (SELECT count(*) FROM public.trip_sample_speed_limits WHERE trip_id = trip) <> 2 THEN
        RAISE EXCEPTION 'TEST: expected one limit per sample';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.trip_sample_speed_limits
        WHERE sample_id = s1 AND speed_limit_kmh = 50 AND provider = 'tomtom'
        AND fetched_at = '2026-11-11T12:01:00Z'::timestamptz) THEN
        RAISE EXCEPTION 'TEST: provenance not preserved';
    END IF;
    result := public.claim_trip_speed_limits(trip, 'hash', 'tomtom', token2);
    IF result <> 'cached' THEN RAISE EXCEPTION 'TEST: repeat must use cache'; END IF;
    PERFORM public.release_trip_speed_limits(trip, token1);
    IF (SELECT status FROM public.trip_speed_limit_runs WHERE trip_id = trip) <> 'completed' THEN
        RAISE EXCEPTION 'TEST: release must not undo completed result';
    END IF;
    IF has_function_privilege('anon', 'public.claim_trip_speed_limits(uuid,text,text,uuid)', 'EXECUTE')
        OR has_function_privilege('authenticated', 'public.complete_trip_speed_limits(uuid,uuid,jsonb,jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'TEST: RPC exposed to frontend role';
    END IF;
    UPDATE public.trips SET status = 'Completed', trip_score = 87 WHERE trip_id = trip;
    BEGIN
        PERFORM public.claim_trip_speed_limits(trip, 'hash', 'tomtom', token2);
        RAISE EXCEPTION 'TEST: old completed trips must not be enriched';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF;
    END;
    IF (SELECT trip_score FROM public.trips WHERE trip_id = trip) <> 87 THEN
        RAISE EXCEPTION 'TEST: stored score changed';
    END IF;
END $$;
ROLLBACK;
