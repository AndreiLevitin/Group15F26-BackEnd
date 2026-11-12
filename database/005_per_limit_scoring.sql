-- AB#73. Fresh installation: apply after 004. Includes the current band-scoring schema.
-- Existing installation: use the separate one-time upgrade; do not rerun CREATE TABLE statements.
-- Adds audit data only; existing trip scores are not updated/backfilled.
BEGIN;

CREATE TABLE public.trip_scoring_results (
    trip_id UUID PRIMARY KEY REFERENCES public.trips(trip_id),
    scoring_version TEXT NOT NULL DEFAULT 'road-limits-v1',
    scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    score NUMERIC CHECK (score BETWEEN 0 AND 100),
    speeding_events INTEGER CHECK (speeding_events >= 0),
    distance_km NUMERIC CHECK (distance_km >= 0),
    valid_readings INTEGER NOT NULL CHECK (valid_readings >= 0),
    ignored_readings INTEGER NOT NULL CHECK (ignored_readings >= 0),
    duplicate_readings INTEGER NOT NULL CHECK (duplicate_readings >= 0),
    tolerance_kmh NUMERIC NOT NULL CHECK (tolerance_kmh >= 0),
    fallback_threshold_kmh NUMERIC CHECK (fallback_threshold_kmh > 0),
    penalty_per_event NUMERIC CHECK (penalty_per_event >= 0),
    minimum_distance_km NUMERIC NOT NULL CHECK (minimum_distance_km > 0),
    minimum_valid_readings INTEGER NOT NULL CHECK (minimum_valid_readings >= 2),
    unscored_reason TEXT,
    scoring_config JSONB,
    quality JSONB,
    CHECK ((score IS NULL) = (unscored_reason IS NOT NULL)),
    CHECK ((score IS NULL) = (speeding_events IS NULL))
);
CREATE TABLE public.trip_sample_scoring (
    sample_id UUID PRIMARY KEY REFERENCES public.trip_data_points(sample_id),
    trip_id UUID NOT NULL REFERENCES public.trip_scoring_results(trip_id),
    status TEXT NOT NULL CHECK (status IN ('used', 'duplicate', 'ignored', 'unscored', 'excluded')),
    speed_limit_kmh_used NUMERIC,
    tolerance_kmh_used NUMERIC,
    threshold_kmh NUMERIC,
    used_fallback BOOLEAN,
    is_speeding BOOLEAN,
    starts_event BOOLEAN,
    reading_score NUMERIC CHECK (reading_score BETWEEN 0 AND 100),
    CHECK ((status = 'used' AND speed_limit_kmh_used IS NOT NULL AND speed_limit_kmh_used > 0
        AND tolerance_kmh_used IS NOT NULL AND tolerance_kmh_used >= 0
        AND threshold_kmh IS NOT NULL AND threshold_kmh = speed_limit_kmh_used + tolerance_kmh_used
        AND used_fallback IS NOT NULL AND is_speeding IS NOT NULL AND starts_event IS NOT NULL
        AND (NOT starts_event OR is_speeding)
        AND (NOT used_fallback OR tolerance_kmh_used = 0))
      OR (status <> 'used' AND speed_limit_kmh_used IS NULL AND tolerance_kmh_used IS NULL
        AND threshold_kmh IS NULL AND used_fallback IS NULL AND is_speeding IS NULL AND starts_event IS NULL))
);
CREATE INDEX trip_sample_scoring_trip_idx ON public.trip_sample_scoring(trip_id);
ALTER TABLE public.trip_scoring_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_sample_scoring ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_scoring_results, public.trip_sample_scoring FROM anon, authenticated;
GRANT ALL ON public.trip_scoring_results, public.trip_sample_scoring TO service_role;

CREATE OR REPLACE FUNCTION public.save_trip_scoring_result(
    p_trip_id UUID, p_result JSONB, p_config JSONB, p_distance_km NUMERIC
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    trip public.trips;
    cfg_tolerance NUMERIC := (p_config->>'toleranceKmh')::numeric;
    cfg_fallback NUMERIC := (p_config->>'fallbackThresholdKmh')::numeric;
    gps_count INTEGER;
    inserted_count INTEGER;
    used_count INTEGER;
    duplicate_count INTEGER;
    ignored_count INTEGER;
    pending_count INTEGER;
    event_count INTEGER;
    scored BOOLEAN;
BEGIN
    SELECT * INTO trip FROM public.trips WHERE trip_id = p_trip_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- No overwrite of historical scores, decisions, timestamps or configuration.
    IF trip.status = 'Completed' THEN RETURN to_jsonb(trip); END IF;
    IF trip.status <> 'Processing' OR trip.end_time IS NULL THEN RETURN NULL; END IF;
    IF p_result->>'scoringStatus' NOT IN ('Scored', 'Unscored') OR p_result->>'scoringStatus' IS NULL THEN
        RAISE EXCEPTION 'Invalid scoring result';
    END IF;
    scored := p_result->>'scoringStatus' = 'Scored';
    IF scored IS DISTINCT FROM (p_result->>'score' IS NOT NULL) THEN
        RAISE EXCEPTION 'Score does not match scoring status';
    END IF;
    SELECT count(*) INTO gps_count FROM public.trip_data_points
        WHERE trip_id = p_trip_id AND latitude IS NOT NULL AND longitude IS NOT NULL;
    IF jsonb_typeof(p_result->'sampleDecisions') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_result->'sampleDecisions') <> gps_count THEN
        RAISE EXCEPTION 'Incomplete sample scoring';
    END IF;
    INSERT INTO public.trip_scoring_results (trip_id, score, speeding_events, distance_km,
        valid_readings, ignored_readings, duplicate_readings, tolerance_kmh, fallback_threshold_kmh,
        penalty_per_event, minimum_distance_km, minimum_valid_readings, unscored_reason)
    VALUES (p_trip_id, (p_result->>'score')::numeric, (p_result->>'speedingEvents')::integer,
        p_distance_km, (p_result->>'validReadings')::integer, (p_result->>'ignoredReadings')::integer,
        (p_result->>'duplicateTimestampReadings')::integer, cfg_tolerance, cfg_fallback,
        (p_config->>'speedingPenaltyPerEvent')::numeric, (p_config->>'minDistanceKm')::numeric,
        (p_config->>'minValidReadings')::integer, p_result->>'reason');
    INSERT INTO public.trip_sample_scoring (sample_id, trip_id, status, speed_limit_kmh_used,
        tolerance_kmh_used, threshold_kmh, used_fallback, is_speeding, starts_event)
    SELECT r."sampleId", p_trip_id, r.status, r."speedLimitKmhUsed", r."toleranceKmhUsed",
        r."thresholdKmh", r."usedFallback", r."isSpeeding", r."startsEvent"
    FROM jsonb_to_recordset(p_result->'sampleDecisions') AS r("sampleId" UUID, status TEXT,
        "speedLimitKmhUsed" NUMERIC, "toleranceKmhUsed" NUMERIC, "thresholdKmh" NUMERIC,
        "usedFallback" BOOLEAN, "isSpeeding" BOOLEAN, "startsEvent" BOOLEAN)
    JOIN public.trip_data_points d ON d.sample_id = r."sampleId" AND d.trip_id = p_trip_id
        AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    IF inserted_count <> gps_count THEN RAISE EXCEPTION 'Sample identity mismatch'; END IF;

    SELECT count(*) FILTER (WHERE status = 'used'), count(*) FILTER (WHERE status = 'duplicate'),
        count(*) FILTER (WHERE status = 'ignored'), count(*) FILTER (WHERE status = 'unscored'),
        count(*) FILTER (WHERE starts_event)
    INTO used_count, duplicate_count, ignored_count, pending_count, event_count
    FROM public.trip_sample_scoring WHERE trip_id = p_trip_id;
    IF ignored_count <> (p_result->>'ignoredReadings')::integer
        OR duplicate_count <> (p_result->>'duplicateTimestampReadings')::integer
        OR used_count + pending_count <> (p_result->>'validReadings')::integer
        OR (scored AND (pending_count <> 0 OR event_count <> (p_result->>'speedingEvents')::integer))
        OR (NOT scored AND used_count <> 0) THEN
        RAISE EXCEPTION 'Inconsistent scoring counts';
    END IF;

    -- TypeScript owns threshold selection, duplicate policy and event grouping.
    -- SQL owns atomic storage, sample identity, constraints and audit counts.

    UPDATE public.trips SET trip_score = (p_result->>'score')::numeric, status = 'Completed',
        distance_km = coalesce(p_distance_km, distance_km)
    WHERE trip_id = p_trip_id RETURNING * INTO trip;
    RETURN to_jsonb(trip);
END $$;
REVOKE ALL ON FUNCTION public.save_trip_scoring_result(UUID, JSONB, JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_trip_scoring_result(UUID, JSONB, JSONB, NUMERIC) TO service_role;
CREATE TABLE public.trip_interval_scoring (
    trip_id UUID NOT NULL REFERENCES public.trip_scoring_results(trip_id),
    start_sample_id UUID NOT NULL REFERENCES public.trip_data_points(sample_id),
    end_sample_id UUID NOT NULL REFERENCES public.trip_data_points(sample_id),
    duration_seconds NUMERIC NOT NULL CHECK (duration_seconds > 0),
    score NUMERIC CHECK (score BETWEEN 0 AND 100),
    exclusion_reason TEXT CHECK (exclusion_reason IN ('gps_gap','invalid_endpoint','stationary','unknown_limit')),
    PRIMARY KEY (trip_id, start_sample_id, end_sample_id),
    CHECK (start_sample_id <> end_sample_id),
    CHECK ((score IS NULL) = (exclusion_reason IS NOT NULL))
);
ALTER TABLE public.trip_interval_scoring ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_interval_scoring FROM anon, authenticated;
GRANT ALL ON public.trip_interval_scoring TO service_role;

-- Separate RPC keeps the old deployed scorer compatible while this migration is applied.
CREATE OR REPLACE FUNCTION public.save_trip_band_scoring_result(
    p_trip_id UUID, p_result JSONB, p_config JSONB, p_distance_km NUMERIC
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    trip public.trips;
    gps_count INTEGER;
    inserted_count INTEGER;
    valid_count INTEGER;
    ignored_count INTEGER;
    duplicate_count INTEGER;
    used_count INTEGER;
    event_count INTEGER;
    scored BOOLEAN;
BEGIN
    SELECT * INTO trip FROM public.trips WHERE trip_id = p_trip_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF trip.status = 'Completed' THEN RETURN to_jsonb(trip); END IF;
    IF trip.status <> 'Processing' OR trip.end_time IS NULL THEN RETURN NULL; END IF;
    IF p_result->>'scoringVersion' IS DISTINCT FROM 'road-bands-v2' OR
        coalesce(p_result->>'scoringStatus', '') NOT IN ('Scored','Unscored') THEN
        RAISE EXCEPTION 'Invalid scoring version or status';
    END IF;
    scored := p_result->>'scoringStatus' = 'Scored';
    IF scored IS DISTINCT FROM (p_result->>'score' IS NOT NULL) THEN RAISE EXCEPTION 'Invalid score status'; END IF;
    IF jsonb_typeof(p_config->'bands') IS DISTINCT FROM 'array' OR
        jsonb_typeof(p_result->'quality') IS DISTINCT FROM 'object' OR
        jsonb_typeof(p_result->'sampleDecisions') IS DISTINCT FROM 'array' OR
        jsonb_typeof(p_result->'intervalDecisions') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Missing scoring audit';
    END IF;
    SELECT count(*) INTO gps_count FROM public.trip_data_points
        WHERE trip_id = p_trip_id AND latitude IS NOT NULL AND longitude IS NOT NULL;
    IF jsonb_array_length(p_result->'sampleDecisions') <> gps_count THEN RAISE EXCEPTION 'Incomplete sample scoring'; END IF;
    INSERT INTO public.trip_scoring_results (trip_id, scoring_version, score, speeding_events, distance_km,
        valid_readings, ignored_readings, duplicate_readings, tolerance_kmh, minimum_distance_km,
        minimum_valid_readings, unscored_reason, scoring_config, quality)
    VALUES (p_trip_id, p_result->>'scoringVersion', (p_result->>'score')::numeric,
        (p_result->>'speedingEvents')::integer, p_distance_km,
        (p_result->>'validReadings')::integer, (p_result->>'ignoredReadings')::integer,
        (p_result->>'duplicateTimestampReadings')::integer, (p_config->>'toleranceKmh')::numeric,
        (p_config->>'minDistanceKm')::numeric, (p_config->>'minValidReadings')::integer,
        p_result->>'reason', p_config, p_result->'quality');
    INSERT INTO public.trip_sample_scoring (sample_id, trip_id, status, speed_limit_kmh_used,
        tolerance_kmh_used, threshold_kmh, used_fallback, is_speeding, starts_event, reading_score)
    SELECT r."sampleId", p_trip_id, r.status, r."speedLimitKmhUsed", r."toleranceKmhUsed",
        r."thresholdKmh", r."usedFallback", r."isSpeeding", r."startsEvent", r."readingScore"
    FROM jsonb_to_recordset(p_result->'sampleDecisions') AS r("sampleId" UUID, status TEXT,
        "speedLimitKmhUsed" NUMERIC, "toleranceKmhUsed" NUMERIC, "thresholdKmh" NUMERIC,
        "usedFallback" BOOLEAN, "isSpeeding" BOOLEAN, "startsEvent" BOOLEAN, "readingScore" NUMERIC)
    JOIN public.trip_data_points d ON d.sample_id = r."sampleId" AND d.trip_id = p_trip_id
        AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    IF inserted_count <> gps_count THEN RAISE EXCEPTION 'Sample identity mismatch'; END IF;
    SELECT count(*) FILTER (WHERE status IN ('used','excluded','unscored')),
        count(*) FILTER (WHERE status = 'ignored'), count(*) FILTER (WHERE status = 'duplicate'),
        count(*) FILTER (WHERE status = 'used'), count(*) FILTER (WHERE starts_event)
    INTO valid_count, ignored_count, duplicate_count, used_count, event_count
    FROM public.trip_sample_scoring WHERE trip_id = p_trip_id;
    IF valid_count IS DISTINCT FROM (p_result->>'validReadings')::integer OR
        ignored_count IS DISTINCT FROM (p_result->>'ignoredReadings')::integer OR
        duplicate_count IS DISTINCT FROM (p_result->>'duplicateTimestampReadings')::integer OR
        (scored AND (event_count IS DISTINCT FROM (p_result->>'speedingEvents')::integer OR
            used_count IS DISTINCT FROM (p_result->'quality'->>'evaluatedReadings')::integer)) OR
        (NOT scored AND used_count <> 0) OR
        EXISTS (SELECT 1 FROM public.trip_sample_scoring WHERE trip_id = p_trip_id AND (used_fallback OR (status = 'used' AND reading_score IS NULL))) THEN
        RAISE EXCEPTION 'Inconsistent scoring counts';
    END IF;
    INSERT INTO public.trip_interval_scoring (trip_id, start_sample_id, end_sample_id, duration_seconds, score, exclusion_reason)
    SELECT p_trip_id, r."startSampleId", r."endSampleId", r."durationSeconds", r.score, r."exclusionReason"
    FROM jsonb_to_recordset(p_result->'intervalDecisions') AS r("startSampleId" UUID, "endSampleId" UUID,
        "durationSeconds" NUMERIC, score NUMERIC, "exclusionReason" TEXT)
    JOIN public.trip_sample_scoring a ON a.sample_id = r."startSampleId" AND a.trip_id = p_trip_id
    JOIN public.trip_sample_scoring b ON b.sample_id = r."endSampleId" AND b.trip_id = p_trip_id;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    IF inserted_count <> jsonb_array_length(p_result->'intervalDecisions') THEN RAISE EXCEPTION 'Interval identity mismatch'; END IF;
    -- Formula, eligibility and quality calculations remain owned by TypeScript.
    UPDATE public.trips SET trip_score = (p_result->>'score')::numeric, status = 'Completed',
        distance_km = coalesce(p_distance_km, distance_km)
    WHERE trip_id = p_trip_id RETURNING * INTO trip;
    RETURN to_jsonb(trip);
END $$;
REVOKE ALL ON FUNCTION public.save_trip_band_scoring_result(UUID, JSONB, JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_trip_band_scoring_result(UUID, JSONB, JSONB, NUMERIC) TO service_role;
COMMIT;
