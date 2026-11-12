-- AB#73. Run in Supabase SQL Editor after the updated 005 or the one-time existing-DB upgrade. All test rows roll back.
BEGIN;
DO $$
DECLARE
    id UUID := gen_random_uuid();
    ids UUID[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
    cfg JSONB := '{"minValidReadings":5,"minDistanceKm":0.1,"toleranceKmh":5,"maxIntervalSeconds":3,"minMovingSpeedKmh":5,"bands":[{"fromKmh":0,"score":80},{"fromKmh":16,"score":60},{"fromKmh":30,"score":40},{"fromKmh":50,"score":0}]}';
    decisions JSONB := '[]';
    intervals JSONB := '[]';
    payload JSONB;
    result JSONB;
    scored_time TIMESTAMPTZ;
    i INTEGER;
BEGIN
    INSERT INTO public.trips(trip_id) VALUES (id);
    FOR i IN 1..5 LOOP
        INSERT INTO public.trip_data_points(sample_id,trip_id,recorded_at,speed_kmh,latitude,longitude,acceleration)
        VALUES (ids[i],id,'2026-11-12T12:00:00Z'::timestamptz+(i-1)*interval '1 second',60,43,-80,0);
        decisions := decisions || jsonb_build_array(jsonb_build_object('sampleId',ids[i],'status','used',
            'speedLimitKmhUsed',50,'toleranceKmhUsed',5,'thresholdKmh',55,'usedFallback',false,
            'isSpeeding',true,'startsEvent',i=1,'readingScore',80));
        IF i>1 THEN intervals := intervals || jsonb_build_array(jsonb_build_object('startSampleId',ids[i-1],
            'endSampleId',ids[i],'durationSeconds',1,'score',80,'exclusionReason',NULL)); END IF;
    END LOOP;
    UPDATE public.trips SET status='Processing',end_time=now() WHERE trip_id=id;
    payload := jsonb_build_object('scoringVersion','road-bands-v2','scoringStatus','Scored','score',80,
        'speedingEvents',1,'validReadings',5,'ignoredReadings',0,'duplicateTimestampReadings',0,
        'sampleDecisions',decisions,'intervalDecisions',intervals,'quality',
        '{"evaluatedReadings":5,"evaluatedSeconds":4,"validMovingSeconds":4,"coveragePercent":100,"unknownLimitSeconds":0,"gpsGapSeconds":0,"stationarySeconds":0,"invalidEndpointSeconds":0,"weightedScore":320,"timeByScore":[{"score":80,"seconds":4}]}'::jsonb);
    BEGIN
        PERFORM public.save_trip_band_scoring_result(id,jsonb_set(payload,'{sampleDecisions}',decisions-0),cfg,0.3);
        RAISE EXCEPTION 'TEST: incomplete samples accepted';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF; END;
    BEGIN
        PERFORM public.save_trip_band_scoring_result(id,jsonb_set(payload,'{intervalDecisions,0,endSampleId}',to_jsonb(gen_random_uuid())),cfg,0.3);
        RAISE EXCEPTION 'TEST: foreign endpoint accepted';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF; END;
    IF EXISTS (SELECT 1 FROM public.trip_scoring_results WHERE trip_id=id) THEN RAISE EXCEPTION 'TEST: failed save left partial audit'; END IF;
    result := public.save_trip_band_scoring_result(id,payload,cfg,0.3);
    IF result->>'status'<>'Completed' OR (result->>'trip_score')::numeric<>80 THEN RAISE EXCEPTION 'TEST: wrong result'; END IF;
    IF (SELECT count(*) FROM public.trip_interval_scoring WHERE trip_id=id)<>4 OR
        NOT EXISTS (SELECT 1 FROM public.trip_scoring_results WHERE trip_id=id AND scoring_version='road-bands-v2'
            AND scoring_config=cfg AND fallback_threshold_kmh IS NULL AND penalty_per_event IS NULL
            AND (quality->>'evaluatedSeconds')::numeric=4) THEN RAISE EXCEPTION 'TEST: audit missing'; END IF;
    SELECT scored_at INTO scored_time FROM public.trip_scoring_results WHERE trip_id=id;
    IF public.save_trip_band_scoring_result(id,jsonb_set(payload,'{score}','0'),cfg,0.3) IS DISTINCT FROM result OR
        (SELECT scored_at FROM public.trip_scoring_results WHERE trip_id=id) IS DISTINCT FROM scored_time THEN
        RAISE EXCEPTION 'TEST: repeat changed historical result'; END IF;
    -- New unscored trip: valid readings can be excluded without inventing fallback limits.
    id := gen_random_uuid();
    INSERT INTO public.trips(trip_id) VALUES (id);
    decisions := '[]'; intervals := '[]';
    FOR i IN 1..5 LOOP
        ids[i] := gen_random_uuid();
        INSERT INTO public.trip_data_points(sample_id,trip_id,recorded_at,speed_kmh,latitude,longitude,acceleration)
        VALUES (ids[i],id,'2026-11-12T12:00:00Z'::timestamptz+(i-1)*interval '1 second',60,43,-80,0);
        decisions := decisions || jsonb_build_array(jsonb_build_object('sampleId',ids[i],'status','excluded'));
        IF i>1 THEN intervals := intervals || jsonb_build_array(jsonb_build_object('startSampleId',ids[i-1],
            'endSampleId',ids[i],'durationSeconds',1,'score',NULL,'exclusionReason','unknown_limit')); END IF;
    END LOOP;
    UPDATE public.trips SET status='Processing',end_time=now() WHERE trip_id=id;
    payload := jsonb_build_object('scoringVersion','road-bands-v2','scoringStatus','Unscored','score',NULL,
        'reason','NO_EVALUATED_INTERVALS','validReadings',5,'ignoredReadings',0,'duplicateTimestampReadings',0,
        'sampleDecisions',decisions,'intervalDecisions',intervals,
        'quality','{"evaluatedReadings":0,"evaluatedSeconds":0,"validMovingSeconds":4,"coveragePercent":0,"unknownLimitSeconds":4}'::jsonb);
    result := public.save_trip_band_scoring_result(id,payload,cfg,0.3);
    IF result->>'trip_score' IS NOT NULL OR result->>'status'<>'Completed' OR
        (SELECT count(*) FROM public.trip_interval_scoring WHERE trip_id=id AND exclusion_reason='unknown_limit')<>4 THEN
        RAISE EXCEPTION 'TEST: exclusions/unscored not saved'; END IF;
    IF has_function_privilege('anon','public.save_trip_band_scoring_result(uuid,jsonb,jsonb,numeric)','EXECUTE') OR
        has_table_privilege('authenticated','public.trip_interval_scoring','SELECT') THEN
        RAISE EXCEPTION 'TEST: public access to scoring audit'; END IF;
END $$;
ROLLBACK;
