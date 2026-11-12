-- AB#72. Apply manually before enabling TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED.
-- Lookup results are separate from raw samples. No historical score is changed.
BEGIN;

CREATE TABLE public.trip_speed_limit_runs (
    trip_id UUID PRIMARY KEY REFERENCES public.trips(trip_id),
    trace_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('fetching', 'completed', 'failed')),
    token UUID NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL
);
CREATE TABLE public.trip_sample_speed_limits (
    sample_id UUID PRIMARY KEY REFERENCES public.trip_data_points(sample_id) ON DELETE CASCADE,
    trip_id UUID NOT NULL REFERENCES public.trips(trip_id),
    speed_limit_kmh NUMERIC CHECK (speed_limit_kmh > 0),
    lookup_status TEXT NOT NULL CHECK (lookup_status IN ('available', 'missing', 'unmatched', 'insufficient_trace', 'invalid_sample')),
    provider TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    provider_segment_id TEXT,
    CHECK ((lookup_status = 'available') = (speed_limit_kmh IS NOT NULL))
);
CREATE INDEX trip_sample_speed_limits_trip_idx ON public.trip_sample_speed_limits(trip_id);
ALTER TABLE public.trip_speed_limit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_sample_speed_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_speed_limit_runs, public.trip_sample_speed_limits FROM anon, authenticated;
GRANT ALL ON public.trip_speed_limit_runs, public.trip_sample_speed_limits TO service_role;

-- Freeze raw input once scoring begins, including uploads that raced the end request.
CREATE FUNCTION public.guard_trip_samples() RETURNS trigger LANGUAGE plpgsql
SET search_path = public AS $$
DECLARE target UUID;
BEGIN
    target := CASE WHEN TG_OP = 'DELETE' THEN OLD.trip_id ELSE NEW.trip_id END;
    IF TG_OP = 'UPDATE' AND NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN
        RAISE EXCEPTION 'Cannot move samples between trips';
    END IF;
    PERFORM 1 FROM public.trips WHERE trip_id = target AND status = 'Active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Samples are immutable after a trip ends'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER guard_trip_samples BEFORE INSERT OR UPDATE OR DELETE ON public.trip_data_points
FOR EACH ROW EXECUTE FUNCTION public.guard_trip_samples();

CREATE FUNCTION public.claim_trip_speed_limits(p_trip_id UUID, p_trace_hash TEXT, p_provider TEXT, p_token UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE run public.trip_speed_limit_runs;
BEGIN
    PERFORM 1 FROM public.trips WHERE trip_id = p_trip_id AND status = 'Processing' AND end_time IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Trip is not ready for enrichment'; END IF;
    SELECT * INTO run FROM public.trip_speed_limit_runs WHERE trip_id = p_trip_id;
    IF FOUND THEN
        IF run.trace_hash = p_trace_hash AND run.status = 'completed' THEN RETURN 'cached'; END IF;
        IF run.status = 'fetching' AND run.lease_until > now() THEN RETURN 'busy'; END IF;
    END IF;
    INSERT INTO public.trip_speed_limit_runs VALUES (p_trip_id, p_trace_hash, p_provider, 'fetching', p_token, now() + interval '3 minutes')
    ON CONFLICT (trip_id) DO UPDATE SET trace_hash = excluded.trace_hash, provider = excluded.provider,
        status = excluded.status, token = excluded.token, lease_until = excluded.lease_until;
    RETURN 'claimed';
END $$;

CREATE FUNCTION public.complete_trip_speed_limits(p_trip_id UUID, p_token UUID, p_samples JSONB, p_limits JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE expected_count INTEGER; saved_count INTEGER; source_provider TEXT;
BEGIN
    PERFORM 1 FROM public.trips WHERE trip_id = p_trip_id AND status = 'Processing' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Trip is not processing'; END IF;
    SELECT provider INTO source_provider FROM public.trip_speed_limit_runs
        WHERE trip_id = p_trip_id AND token = p_token AND status = 'fetching' AND lease_until > now() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Enrichment lease expired'; END IF;
    SELECT count(*) INTO expected_count FROM public.trip_data_points
        WHERE trip_id = p_trip_id AND latitude IS NOT NULL AND longitude IS NOT NULL;
    IF jsonb_array_length(p_samples) <> expected_count OR jsonb_array_length(p_limits) <> expected_count THEN
        RAISE EXCEPTION 'Trace changed or result incomplete';
    END IF;
    SELECT count(*) INTO saved_count FROM jsonb_to_recordset(p_samples)
        AS s("sampleId" UUID, "recordedAt" TIMESTAMPTZ, latitude NUMERIC, longitude NUMERIC)
        JOIN public.trip_data_points d ON d.sample_id = s."sampleId" AND d.trip_id = p_trip_id
        AND d.recorded_at = s."recordedAt" AND d.latitude = s.latitude AND d.longitude = s.longitude;
    IF saved_count <> expected_count THEN RAISE EXCEPTION 'Trace changed'; END IF;
    DELETE FROM public.trip_sample_speed_limits WHERE trip_id = p_trip_id;
    INSERT INTO public.trip_sample_speed_limits (sample_id, trip_id, speed_limit_kmh, lookup_status, provider, fetched_at, provider_segment_id)
    SELECT l."sampleId", p_trip_id, l."speedLimitKmh", l.status, l.provider, l."fetchedAt", l."providerSegmentId"
        FROM jsonb_to_recordset(p_limits) AS l("sampleId" UUID, "speedLimitKmh" NUMERIC, status TEXT,
            provider TEXT, "fetchedAt" TIMESTAMPTZ, "providerSegmentId" TEXT)
        JOIN public.trip_data_points d ON d.sample_id = l."sampleId" AND d.trip_id = p_trip_id
        AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL
        WHERE l.provider = source_provider;
    GET DIAGNOSTICS saved_count = ROW_COUNT;
    IF saved_count <> expected_count THEN RAISE EXCEPTION 'Incomplete enrichment'; END IF;
    UPDATE public.trip_speed_limit_runs SET status = 'completed' WHERE trip_id = p_trip_id AND token = p_token;
END $$;

CREATE FUNCTION public.release_trip_speed_limits(p_trip_id UUID, p_token UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE public.trip_speed_limit_runs SET status = 'failed', lease_until = now()
        WHERE trip_id = p_trip_id AND token = p_token AND status = 'fetching';
$$;
REVOKE ALL ON FUNCTION public.claim_trip_speed_limits(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_trip_speed_limits(UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_trip_speed_limits(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_trip_speed_limits(UUID, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_trip_speed_limits(UUID, UUID, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_trip_speed_limits(UUID, UUID) TO service_role;
COMMIT;
