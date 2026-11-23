-- AB#95. Run as owner in a TEST database after migrations 001–010.
-- Uses synthetic scoring payloads through the real scoring-storage RPC.
-- Does not call the GPS scorer, HTTP endpoints, or external providers.
BEGIN;

CREATE TEMP TABLE proof95_results (
    step INTEGER PRIMARY KEY,
    phase TEXT NOT NULL,
    stored_rows JSONB NOT NULL
);

CREATE TEMP TABLE proof95_context (
    driver UUID NOT NULL,
    pending JSONB
);

INSERT INTO proof95_context(driver) VALUES (gen_random_uuid());
INSERT INTO auth.users(id, email)
SELECT driver, driver::text || '@example.test' FROM proof95_context;

-- Prepare an owned trip and five valid sample/audit identities.
CREATE FUNCTION pg_temp.prepare_proof95_trip(owner_id UUID, score NUMERIC)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    trip UUID := gen_random_uuid();
    samples UUID[] := ARRAY[
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid()
    ];
    starts TIMESTAMPTZ := date_trunc(
        'day', statement_timestamp() AT TIME ZONE 'America/Toronto'
    ) AT TIME ZONE 'America/Toronto';
    decisions JSONB := '[]';
    intervals JSONB := '[]';
    speed NUMERIC := CASE WHEN score = 80 THEN 60 ELSE 110 END;
    cfg JSONB := '{
        "minValidReadings":5,
        "minDistanceKm":0.1,
        "toleranceKmh":5,
        "maxIntervalSeconds":3,
        "minMovingSpeedKmh":5,
        "bands":[
            {"fromKmh":0,"score":80},
            {"fromKmh":16,"score":60},
            {"fromKmh":30,"score":40},
            {"fromKmh":50,"score":0}
        ]
    }';
    payload JSONB;
    i INTEGER;
BEGIN
    INSERT INTO public.trips(trip_id, user_id, start_time)
    VALUES (trip, owner_id, starts);

    FOR i IN 1..5 LOOP
        INSERT INTO public.trip_data_points(
            sample_id, trip_id, recorded_at,
            speed_kmh, latitude, longitude, acceleration
        ) VALUES (
            samples[i], trip, starts + (i-1)*interval '1 second',
            speed, 43, -80, 0
        );

        decisions := decisions || jsonb_build_array(jsonb_build_object(
            'sampleId', samples[i],
            'status', 'used',
            'speedLimitKmhUsed', 50,
            'toleranceKmhUsed', 5,
            'thresholdKmh', 55,
            'usedFallback', false,
            'isSpeeding', true,
            'startsEvent', i = 1,
            'readingScore', score
        ));

        IF i > 1 THEN
            intervals := intervals || jsonb_build_array(jsonb_build_object(
                'startSampleId', samples[i-1],
                'endSampleId', samples[i],
                'durationSeconds', 1,
                'score', score,
                'exclusionReason', NULL
            ));
        END IF;
    END LOOP;

    UPDATE public.trips
    SET status = 'Processing', end_time = starts + interval '4 seconds'
    WHERE trip_id = trip;

    payload := jsonb_build_object(
        'scoringVersion', 'road-bands-v2',
        'scoringStatus', 'Scored',
        'score', score,
        'speedingEvents', 1,
        'validReadings', 5,
        'ignoredReadings', 0,
        'duplicateTimestampReadings', 0,
        'sampleDecisions', decisions,
        'intervalDecisions', intervals,
        'quality', jsonb_build_object(
            'evaluatedReadings', 5,
            'evaluatedSeconds', 4,
            'validMovingSeconds', 4,
            'coveragePercent', 100,
            'unknownLimitSeconds', 0,
            'gpsGapSeconds', 0,
            'stationarySeconds', 0,
            'invalidEndpointSeconds', 0,
            'weightedScore', score * 4,
            'timeByScore', jsonb_build_array(
                jsonb_build_object('score', score, 'seconds', 4)
            )
        )
    );

    RETURN jsonb_build_object(
        'tripId', trip,
        'payload', payload,
        'config', cfg
    );
END $$;

CREATE FUNCTION pg_temp.record_proof95_state(
    step_number INTEGER,
    phase_name TEXT,
    owner_id UUID,
    expected_score NUMERIC,
    expected_count INTEGER
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    snapshot JSONB;
BEGIN
    -- Read stored rows directly: this assertion never refreshes them itself.
    SELECT jsonb_agg(to_jsonb(a) ORDER BY a.period_type, a.period_start)
    INTO snapshot
    FROM public.score_averages a
    WHERE a.driver_id = owner_id;

    IF jsonb_array_length(snapshot) IS DISTINCT FROM 6 THEN
        RAISE EXCEPTION 'TEST: % must have six stored periods', phase_name;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.score_averages
        WHERE driver_id = owner_id
            AND (
                average_score IS DISTINCT FROM expected_score
                OR trip_count IS DISTINCT FROM expected_count
            )
    ) THEN
        RAISE EXCEPTION 'TEST: incorrect stored averages after %', phase_name;
    END IF;

    INSERT INTO proof95_results VALUES (
        step_number, phase_name, snapshot
    );
END $$;

DO $$
DECLARE
    owner_id UUID := (SELECT driver FROM proof95_context);
    first_trip JSONB;
    second_trip JSONB;
    pending_trip JSONB;
BEGIN
    first_trip := pg_temp.prepare_proof95_trip(owner_id, 80);
    PERFORM public.save_trip_band_scoring_result(
        (first_trip->>'tripId')::uuid,
        first_trip->'payload', first_trip->'config', 0.3
    );
    PERFORM pg_temp.record_proof95_state(0, 'baseline', owner_id, 80, 1);

    second_trip := pg_temp.prepare_proof95_trip(owner_id, 0);
    PERFORM public.save_trip_band_scoring_result(
        (second_trip->>'tripId')::uuid,
        second_trip->'payload', second_trip->'config', 0.3
    );
    PERFORM pg_temp.record_proof95_state(1, 'second_score_saved', owner_id, 40, 2);

    UPDATE public.trips SET is_excluded = true
    WHERE trip_id = (second_trip->>'tripId')::uuid;

    IF NOT EXISTS (
        SELECT 1 FROM public.trips
        WHERE trip_id = (second_trip->>'tripId')::uuid
            AND trip_score = 0 AND is_excluded
    ) THEN
        RAISE EXCEPTION 'TEST: exclusion changed or lost the original score';
    END IF;

    PERFORM pg_temp.record_proof95_state(2, 'trip_excluded', owner_id, 80, 1);

    pending_trip := pg_temp.prepare_proof95_trip(owner_id, 0);
    UPDATE proof95_context SET pending = pending_trip;
END $$;

-- Fail during average writes, inside the scoring RPC transaction.
CREATE FUNCTION pg_temp.fail_proof95_average()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.period_type = 'year' THEN
        RAISE EXCEPTION 'proof95 forced recalculation failure';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER proof95_forced_failure
    BEFORE INSERT OR UPDATE ON public.score_averages
    FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_proof95_average();

DO $$
DECLARE
    owner_id UUID := (SELECT driver FROM proof95_context);
    prepared JSONB := (SELECT pending FROM proof95_context);
    trip UUID := (prepared->>'tripId')::uuid;
BEGIN
    BEGIN
        PERFORM public.save_trip_band_scoring_result(
            trip, prepared->'payload', prepared->'config', 0.3
        );
        RAISE EXCEPTION 'TEST: forced failure was ignored';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'proof95 forced recalculation failure' THEN
            RAISE;
        END IF;
    END;

    IF NOT EXISTS (
        SELECT 1 FROM public.trips
        WHERE trip_id = trip
            AND status = 'Processing' AND trip_score IS NULL
    ) OR EXISTS (
        SELECT 1 FROM public.trip_scoring_results WHERE trip_id = trip
    ) OR EXISTS (
        SELECT 1 FROM public.trip_sample_scoring WHERE trip_id = trip
    ) OR EXISTS (
        SELECT 1 FROM public.trip_interval_scoring WHERE trip_id = trip
    ) THEN
        RAISE EXCEPTION 'TEST: failed scoring left partial trip or audit changes';
    END IF;

    PERFORM pg_temp.record_proof95_state(3, 'failed_recalculation', owner_id, 80, 1);

    IF (SELECT stored_rows FROM proof95_results WHERE step = 2)
        IS DISTINCT FROM
        (SELECT stored_rows FROM proof95_results WHERE step = 3)
    THEN
        RAISE EXCEPTION 'TEST: failure changed previous stored rows';
    END IF;
END $$;

DROP TRIGGER proof95_forced_failure ON public.score_averages;

DO $$
DECLARE
    owner_id UUID := (SELECT driver FROM proof95_context);
    prepared JSONB := (SELECT pending FROM proof95_context);
BEGIN
    PERFORM public.save_trip_band_scoring_result(
        (prepared->>'tripId')::uuid,
        prepared->'payload', prepared->'config', 0.3
    );
    PERFORM pg_temp.record_proof95_state(4, 'successful_retry', owner_id, 40, 2);
END $$;

SELECT p.phase, r.period_type, r.average_score, r.trip_count
FROM proof95_results p
CROSS JOIN LATERAL jsonb_to_recordset(p.stored_rows)
    AS r(period_type TEXT, average_score NUMERIC, trip_count INTEGER)
ORDER BY p.step, r.period_type;

ROLLBACK;
