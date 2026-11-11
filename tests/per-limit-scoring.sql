-- AB#73. Run after migrations 001–005 as SQL editor owner. Test rows roll back.
BEGIN;
DO $$
DECLARE
    id UUID := gen_random_uuid();
    samples UUID[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
    speeds NUMERIC[] := ARRAY[55,56,70,86,65];
    road_limits NUMERIC[] := ARRAY[50,50,NULL,NULL,60];
    cfg JSONB := '{"minValidReadings":5,"minDistanceKm":0.1,"speedingPenaltyPerEvent":2,"toleranceKmh":5,"fallbackThresholdKmh":85}';
    decisions JSONB := '[]';
    payload JSONB;
    first_result JSONB;
    repeated JSONB;
    threshold NUMERIC;
    i INTEGER;
    fetched TIMESTAMPTZ := now();
    original_scored_at TIMESTAMPTZ;
BEGIN
    INSERT INTO public.trips(trip_id) VALUES (id);
    FOR i IN 1..5 LOOP
        INSERT INTO public.trip_data_points(sample_id,trip_id,recorded_at,speed_kmh,acceleration,latitude,longitude)
            VALUES (samples[i],id,'2026-11-11T12:00:00Z'::timestamptz + (i-1)*interval '1 second',speeds[i],0,43 + i*0.0001,-80);
        INSERT INTO public.trip_sample_speed_limits(sample_id,trip_id,speed_limit_kmh,lookup_status,provider,fetched_at)
            VALUES (samples[i],id,road_limits[i],CASE WHEN road_limits[i] IS NULL THEN 'missing' ELSE 'available' END,'tomtom',fetched);
        threshold := CASE WHEN road_limits[i] IS NULL THEN 85 ELSE road_limits[i]+5 END;
        decisions := decisions || jsonb_build_array(jsonb_build_object(
            'sampleId',samples[i], 'status','used',
            'speedLimitKmhUsed',coalesce(road_limits[i],85),
            'toleranceKmhUsed',CASE WHEN road_limits[i] IS NULL THEN 0 ELSE 5 END,
            'thresholdKmh',threshold,'usedFallback',road_limits[i] IS NULL,
            'isSpeeding',speeds[i]>threshold,'startsEvent',i IN (2,4)));
    END LOOP;
    UPDATE public.trips SET status='Processing',end_time=now() WHERE trip_id=id;
    -- 0.3 km < 0.5 km. Hand calculation: round(100 - 2 events * 2 / 0.3) = 87.
    payload := jsonb_build_object('scoringStatus','Scored','score',87,'speedingEvents',2,
        'distanceKm',0.3,'validReadings',5,'ignoredReadings',0,'duplicateTimestampReadings',0,'sampleDecisions',decisions);
    BEGIN
        PERFORM public.save_trip_scoring_result(id,jsonb_set(payload,'{sampleDecisions}',decisions-'0'::integer),cfg,0.3);
        RAISE EXCEPTION 'TEST: partial decisions must fail';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.trip_scoring_results WHERE trip_id=id) THEN
        RAISE EXCEPTION 'TEST: failed transaction left a partial result';
    END IF;
    BEGIN
        PERFORM public.save_trip_scoring_result(id,
            jsonb_set(jsonb_set(payload,'{sampleDecisions,2,thresholdKmh}','90'),
                '{sampleDecisions,2,speedLimitKmhUsed}','90'),cfg,0.3);
        RAISE EXCEPTION 'TEST: fallback 90 must fail';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST:%' THEN RAISE; END IF;
    END;
    first_result := public.save_trip_scoring_result(id,payload,cfg,0.3);
    IF first_result->>'status'<>'Completed' OR (first_result->>'trip_score')::numeric<>87 THEN
        RAISE EXCEPTION 'TEST: score/state not committed';
    END IF;
    IF (SELECT count(*) FROM public.trip_sample_scoring WHERE trip_id=id AND used_fallback)<>2
        OR (SELECT count(*) FROM public.trip_sample_scoring WHERE trip_id=id AND starts_event)<>2 THEN
        RAISE EXCEPTION 'TEST: fallback/event markers not stored';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.trip_scoring_results WHERE trip_id=id AND distance_km=0.3
        AND penalty_per_event=2 AND tolerance_kmh=5 AND fallback_threshold_kmh=85 AND speeding_events=2) THEN
        RAISE EXCEPTION 'TEST: reproducibility snapshot missing';
    END IF;
    SELECT scored_at INTO original_scored_at FROM public.trip_scoring_results WHERE trip_id=id;
    repeated := public.save_trip_scoring_result(id,jsonb_set(payload,'{score}','0'),cfg,10);
    IF repeated IS DISTINCT FROM first_result
        OR (SELECT scored_at FROM public.trip_scoring_results WHERE trip_id=id) IS DISTINCT FROM original_scored_at THEN
        RAISE EXCEPTION 'TEST: repeat overwrote completed result';
    END IF;
    IF has_function_privilege('anon','public.save_trip_scoring_result(uuid,jsonb,jsonb,numeric)','EXECUTE') THEN
        RAISE EXCEPTION 'TEST: frontend can write scoring results';
    END IF;
END $$;
ROLLBACK;
