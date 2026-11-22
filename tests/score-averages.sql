-- AB#93. Run as owner in a TEST database after migrations 001–007.
-- All test accounts, trips and averages roll back.
BEGIN;

CREATE TEMP TABLE average_test_ids (
    a UUID DEFAULT gen_random_uuid(),
    b UUID DEFAULT gen_random_uuid()
);
INSERT INTO average_test_ids DEFAULT VALUES;

DO $$
DECLARE
    a UUID := (SELECT i.a FROM average_test_ids i);
    b UUID := (SELECT i.b FROM average_test_ids i);
BEGIN
    INSERT INTO auth.users(id, email) VALUES
        (a, a::text || '@example.test'),
        (b, b::text || '@example.test');

    -- Deliberately use a different session timezone.
    SET LOCAL TIME ZONE 'UTC';

    INSERT INTO public.trips
        (user_id, start_time, end_time, status, trip_score, is_excluded)
    VALUES
        (a, '2026-03-02T00:00:00-05:00', '2026-03-02T00:01:00-05:00', 'Completed', 0, false),
        (a, '2026-03-02T12:00:00-05:00', '2026-03-02T12:01:00-05:00', 'Completed', 100, false),
        (a, '2026-03-01T23:59:59-05:00', '2026-03-02T00:01:00-05:00', 'Completed', 80, false),
        (a, '2026-02-01T00:00:00-05:00', '2026-02-01T00:01:00-05:00', 'Completed', 50, false),
        (a, '2026-01-31T23:59:59-05:00', '2026-02-01T00:01:00-05:00', 'Completed', 90, false),
        (a, '2025-12-31T23:59:59-05:00', '2026-01-01T00:01:00-05:00', 'Completed', 20, false),
        (a, '2026-03-02T01:00:00-05:00', NULL, 'Processing', 99, false),
        (a, '2026-03-02T01:00:00-05:00', NULL, 'Invalid', 99, false),
        (a, '2026-03-02T01:00:00-05:00', NULL, 'Completed', NULL, false),
        (a, '2026-03-02T01:00:00-05:00', NULL, 'Completed', 100, true),
        (a, '2026-03-02T18:00:00-05:00', NULL, 'Completed', 90, false);

    PERFORM public.recompute_score_averages(a, '2026-03-02T12:00:00-05:00');

    IF EXISTS (
        SELECT 1
        FROM (VALUES
            ('day', '2026-03-02T00:00:00-05:00'::timestamptz, 50.00, 2),
            ('week', '2026-03-02T00:00:00-05:00'::timestamptz, 50.00, 2),
            ('month', '2026-03-01T00:00:00-05:00'::timestamptz, 60.00, 3),
            ('year', '2026-01-01T00:00:00-05:00'::timestamptz, 64.00, 5),
            ('last_30_days', '2026-02-01T00:00:00-05:00'::timestamptz, 57.50, 4),
            ('all_time', '1970-01-01T00:00:00Z'::timestamptz, 56.67, 6)
        ) expected(kind, starts, score, trips)
        LEFT JOIN public.score_averages stored
            ON stored.driver_id = a
            AND stored.period_type = expected.kind
            AND stored.period_start = expected.starts
        WHERE stored.average_score IS DISTINCT FROM expected.score
            OR stored.trip_count IS DISTINCT FROM expected.trips
    ) THEN
        RAISE EXCEPTION 'TEST: incorrect averages, counts or Ontario boundaries';
    END IF;

    PERFORM public.recompute_score_averages(b, '2026-03-02T12:00:00-05:00');
    IF (SELECT count(*) FROM public.score_averages
        WHERE driver_id = b AND trip_count = 0 AND average_score IS NULL) <> 6
    THEN
        RAISE EXCEPTION 'TEST: empty account must have six empty periods';
    END IF;

    -- Spring daylight-saving change: local midnight is still -05:00.
    INSERT INTO public.trips(user_id, start_time, status, trip_score)
    VALUES
        (b, '2026-03-07T23:59:59-05:00', 'Completed', 20),
        (b, '2026-03-08T00:00:00-05:00', 'Completed', 80);

    PERFORM public.recompute_score_averages(b, '2026-03-08T12:00:00-04:00');
    IF NOT EXISTS (
        SELECT 1 FROM public.score_averages
        WHERE driver_id = b AND period_type = 'day'
            AND period_start = '2026-03-08T00:00:00-05:00'
            AND average_score = 80 AND trip_count = 1
    ) THEN
        RAISE EXCEPTION 'TEST: spring daylight-saving boundary failed';
    END IF;

    -- Exclusion automatically recalculates; original scores remain stored.
    UPDATE public.trips SET is_excluded = true WHERE user_id = b;
    IF NOT EXISTS (
        SELECT 1 FROM public.score_averages
        WHERE driver_id = b AND period_type = 'all_time'
            AND trip_count = 0 AND average_score IS NULL
    ) OR (SELECT sum(trip_score) FROM public.trips WHERE user_id = b) <> 100
    THEN
        RAISE EXCEPTION 'TEST: exclusion failed or changed original scores';
    END IF;

    -- Both occurrences of 01:30 belong to the same Ontario day.
    INSERT INTO public.trips(user_id, start_time, status, trip_score)
    VALUES
        (b, '2026-11-01T01:30:00-04:00', 'Completed', 20),
        (b, '2026-11-01T01:30:00-05:00', 'Completed', 80);

    PERFORM public.recompute_score_averages(b, '2026-11-01T12:00:00-05:00');
    IF NOT EXISTS (
        SELECT 1 FROM public.score_averages
        WHERE driver_id = b AND period_type = 'day'
            AND period_start = '2026-11-01T00:00:00-04:00'
            AND average_score = 50 AND trip_count = 2
    ) THEN
        RAISE EXCEPTION 'TEST: autumn daylight-saving boundary failed';
    END IF;

    -- Advancing the clock expires the rolling window without new trips.
    PERFORM public.recompute_score_averages(b, '2026-12-02T12:00:00-05:00');
    IF NOT EXISTS (
        SELECT 1 FROM public.score_averages
        WHERE driver_id = b AND period_type = 'last_30_days'
            AND period_start = '2026-11-03T00:00:00-05:00'
            AND average_score IS NULL AND trip_count = 0
    ) THEN
        RAISE EXCEPTION 'TEST: expired rolling trips still counted';
    END IF;
END $$;

CREATE TEMP TABLE averages_before_failure AS
    SELECT * FROM public.score_averages;

CREATE FUNCTION pg_temp.fail_average_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.period_type = 'year' THEN
        RAISE EXCEPTION 'simulated average failure';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER test_average_failure
    BEFORE INSERT OR UPDATE ON public.score_averages
    FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_average_write();

DO $$
DECLARE
    a UUID := (SELECT i.a FROM average_test_ids i);
BEGIN
    BEGIN
        UPDATE public.trips SET is_excluded = true WHERE user_id = a;
        RAISE EXCEPTION 'TEST: failing calculation was accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'simulated average failure' THEN RAISE; END IF;
    END;

    IF EXISTS (
        (SELECT * FROM public.score_averages
         EXCEPT SELECT * FROM averages_before_failure)
        UNION ALL
        (SELECT * FROM averages_before_failure
         EXCEPT SELECT * FROM public.score_averages)
    ) THEN
        RAISE EXCEPTION 'TEST: failed calculation changed stored averages';
    END IF;

    IF (SELECT count(*) FROM public.trips
        WHERE user_id = a AND is_excluded) <> 1
    THEN
        RAISE EXCEPTION 'TEST: failed calculation committed trip changes';
    END IF;
END $$;

SELECT 'score averages tests passed' AS result;
ROLLBACK;
