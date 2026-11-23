-- AB#94. Run after migrations 001–010 in a TEST database.
BEGIN;

CREATE TEMP TABLE current_average_test_ids AS
SELECT gen_random_uuid() AS a,
       gen_random_uuid() AS b,
       gen_random_uuid() AS c;

GRANT SELECT ON current_average_test_ids TO authenticated;

INSERT INTO auth.users(id, email)
SELECT a, a::text || '@example.test' FROM current_average_test_ids
UNION ALL
SELECT b, b::text || '@example.test' FROM current_average_test_ids
UNION ALL
SELECT c, c::text || '@example.test' FROM current_average_test_ids;

INSERT INTO public.trips(user_id, start_time, status, trip_score)
SELECT a, '2020-01-01T12:00:00-05:00'::timestamptz, 'Completed', 80
FROM current_average_test_ids
UNION ALL
SELECT a, statement_timestamp(), 'Completed', 0
FROM current_average_test_ids
UNION ALL
SELECT b, statement_timestamp(), 'Completed', 20
FROM current_average_test_ids;

-- Simulate yesterday's stored values before the first authenticated read.
SELECT public.recompute_score_averages(
    a,
    (date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Toronto')
        AT TIME ZONE 'America/Toronto') - interval '1 second'
) FROM current_average_test_ids;

SET LOCAL ROLE authenticated;

-- Account A: historical 80 plus current 0 gives all-time average 40.
SELECT set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', a, 'role', 'authenticated')::text,
    true
) FROM current_average_test_ids;

DO $$
DECLARE
    rows JSONB;
BEGIN
    SELECT jsonb_agg(to_jsonb(r)) INTO rows
    FROM public.get_my_score_averages() r;

    IF jsonb_array_length(rows) IS DISTINCT FROM 6 THEN
        RAISE EXCEPTION 'TEST: must return six current periods';
    END IF;

    IF (SELECT count(DISTINCT r->>'period_type')
        FROM jsonb_array_elements(rows) r) <> 6
    THEN
        RAISE EXCEPTION 'TEST: duplicate or missing periods';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(rows) r
        WHERE r->>'period_type' = 'all_time'
            AND (r->>'average_score')::numeric = 40
            AND (r->>'trip_count')::integer = 2
    ) THEN
        RAISE EXCEPTION 'TEST: A received incorrect or foreign averages';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(rows) r
        WHERE r->>'period_type' = 'day'
            AND (r->>'average_score')::numeric = 0
            AND (r->>'trip_count')::integer = 1
            AND (r->>'period_start')::timestamptz =
                date_trunc(
                    'day',
                    statement_timestamp() AT TIME ZONE 'America/Toronto'
                ) AT TIME ZONE 'America/Toronto'
    ) THEN
        RAISE EXCEPTION 'TEST: current Ontario day or zero score is incorrect';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.score_averages
        WHERE driver_id <> (SELECT a FROM current_average_test_ids)
    ) THEN
        RAISE EXCEPTION 'TEST: direct reads expose another account';
    END IF;

    BEGIN
        PERFORM public.recompute_score_averages(
            (SELECT b FROM current_average_test_ids)
        );
        RAISE EXCEPTION 'TEST: caller can recompute an arbitrary account';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;

-- Account B must receive 20, not A's 40.
SELECT set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', b, 'role', 'authenticated')::text,
    true
) FROM current_average_test_ids;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.get_my_score_averages()
        WHERE period_type = 'all_time'
            AND average_score = 20 AND trip_count = 1
    ) THEN
        RAISE EXCEPTION 'TEST: B received incorrect or foreign averages';
    END IF;
END $$;

-- Account C has no trips: six empty periods, without invented zero scores.
SELECT set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', c, 'role', 'authenticated')::text,
    true
) FROM current_average_test_ids;

DO $$
BEGIN
    IF (SELECT count(*) FROM public.get_my_score_averages()
        WHERE average_score IS NULL AND trip_count = 0) <> 6
    THEN
        RAISE EXCEPTION 'TEST: new account must receive six empty periods';
    END IF;
END $$;

-- Even an authenticated database role needs an actual user identity.
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);

DO $$
BEGIN
    BEGIN
        PERFORM public.get_my_score_averages();
        RAISE EXCEPTION 'TEST: missing identity was accepted';
    EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
    END;
END $$;

SET LOCAL ROLE anon;

DO $$
BEGIN
    BEGIN
        PERFORM public.get_my_score_averages();
        RAISE EXCEPTION 'TEST: anonymous caller can read averages';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;

RESET ROLE;

-- Repeated reads must not write when the stored periods are current.
CREATE FUNCTION public.reject_average_write_94()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'TEST: fresh read unexpectedly recalculated averages';
END $$;

CREATE TRIGGER reject_average_write_94
    BEFORE INSERT OR UPDATE OR DELETE ON public.score_averages
    FOR EACH ROW EXECUTE FUNCTION public.reject_average_write_94();

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
    jsonb_build_object('sub', a, 'role', 'authenticated')::text, true
) FROM current_average_test_ids;

SELECT * FROM public.get_my_score_averages();
SELECT * FROM public.get_my_score_averages();

-- An initialized empty account must also reuse its stored values.
SELECT set_config('request.jwt.claims',
    jsonb_build_object('sub', c, 'role', 'authenticated')::text, true
) FROM current_average_test_ids;

SELECT * FROM public.get_my_score_averages();

RESET ROLE;
DROP TRIGGER reject_average_write_94 ON public.score_averages;
DROP FUNCTION public.reject_average_write_94();

SELECT 'current score averages checks passed' AS result;
ROLLBACK;
