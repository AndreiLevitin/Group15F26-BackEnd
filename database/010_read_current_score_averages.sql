-- AB#94. Apply after 009_score_averages.sql.
-- Read stored current periods; refresh only when missing or outdated.
BEGIN;

CREATE FUNCTION public.get_my_score_averages()
RETURNS TABLE (
    period_type TEXT,
    period_start TIMESTAMPTZ,
    average_score NUMERIC,
    trip_count INTEGER,
    calculated_at TIMESTAMPTZ
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
    caller UUID := auth.uid();
    calculation_time TIMESTAMPTZ := statement_timestamp();
    local_midnight TIMESTAMP;
BEGIN
    IF caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '28000';
    END IF;

    local_midnight := date_trunc(
        'day',
        calculation_time AT TIME ZONE 'America/Toronto'
    );

    -- Identity comes from the database session, never a supplied user ID.
    -- The caller cannot supply a calculation timestamp either.
    -- Trip changes already refresh the stored averages.
    -- Refresh on read only for missing periods or an older Ontario date.
    IF (
        SELECT count(*)
        FROM public.score_averages a
        WHERE a.driver_id = caller
            AND (a.calculated_at AT TIME ZONE 'America/Toronto')::date
                = local_midnight::date
            AND a.period_start = CASE a.period_type
                WHEN 'all_time' THEN
                    '1970-01-01T00:00:00Z'::timestamptz
                WHEN 'last_30_days' THEN
                    (local_midnight - interval '29 days')
                        AT TIME ZONE 'America/Toronto'
                ELSE date_trunc(
                    a.period_type,
                    calculation_time AT TIME ZONE 'America/Toronto'
                ) AT TIME ZONE 'America/Toronto'
            END
    ) <> 6 THEN
        PERFORM public.recompute_score_averages(caller, calculation_time);
    END IF;

    RETURN QUERY
    SELECT
        a.period_type,
        a.period_start,
        a.average_score,
        a.trip_count,
        a.calculated_at
    FROM public.score_averages a
    WHERE a.driver_id = caller
        AND a.period_start = CASE a.period_type
            WHEN 'all_time' THEN
                '1970-01-01T00:00:00Z'::timestamptz
            WHEN 'last_30_days' THEN
                (local_midnight - interval '29 days')
                    AT TIME ZONE 'America/Toronto'
            ELSE
                date_trunc(
                    a.period_type,
                    calculation_time AT TIME ZONE 'America/Toronto'
                ) AT TIME ZONE 'America/Toronto'
        END
    ORDER BY CASE a.period_type
        WHEN 'day' THEN 1
        WHEN 'week' THEN 2
        WHEN 'month' THEN 3
        WHEN 'year' THEN 4
        WHEN 'last_30_days' THEN 5
        WHEN 'all_time' THEN 6
    END;
END $$;

REVOKE ALL ON FUNCTION public.get_my_score_averages()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_score_averages()
    TO authenticated;

COMMIT;
