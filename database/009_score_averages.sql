-- AB#93. Apply once as owner after migrations 001–008.
-- Calendar periods use America/Toronto, including daylight saving time.
-- Weeks start on Monday. Last 30 days includes today and 29 preceding dates.
BEGIN;

ALTER TABLE public.trips
    ADD COLUMN is_excluded BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE public.score_averages (
    average_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES auth.users(id),
    period_type TEXT NOT NULL CHECK (period_type IN
        ('day', 'week', 'month', 'year', 'last_30_days', 'all_time')),
    period_start TIMESTAMPTZ NOT NULL,
    average_score NUMERIC(5,2) CHECK (average_score BETWEEN 0 AND 100),
    trip_count INTEGER NOT NULL CHECK (trip_count >= 0),
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (driver_id, period_type, period_start),
    CHECK ((trip_count = 0) = (average_score IS NULL))
);

ALTER TABLE public.score_averages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.score_averages FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.score_averages TO service_role;
GRANT SELECT ON public.score_averages TO authenticated;

CREATE POLICY score_averages_select_own ON public.score_averages
    FOR SELECT TO authenticated
    USING (driver_id = (SELECT auth.uid()));

CREATE FUNCTION public.recompute_score_averages(
    p_driver_id UUID,
    p_as_of TIMESTAMPTZ DEFAULT statement_timestamp()
) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
    local_day TIMESTAMPTZ;
    rolling_start TIMESTAMPTZ;
BEGIN
    IF p_driver_id IS NULL THEN RETURN; END IF;

    IF p_as_of IS NULL OR NOT isfinite(p_as_of) THEN
        RAISE EXCEPTION 'A finite calculation time is required';
    END IF;

    local_day := date_trunc(
        'day', p_as_of AT TIME ZONE 'America/Toronto'
    ) AT TIME ZONE 'America/Toronto';

    rolling_start := (
        local_day AT TIME ZONE 'America/Toronto' - interval '29 days'
    ) AT TIME ZONE 'America/Toronto';

    -- Lock the driver's fixed all-time row before reading trips.
    -- This date identifies the bucket; it does not filter trip dates.
    INSERT INTO public.score_averages AS a
        (driver_id, period_type, period_start,
         average_score, trip_count, calculated_at)
    VALUES (
        p_driver_id, 'all_time', '1970-01-01T00:00:00Z',
        NULL, 0, p_as_of
    )
    ON CONFLICT (driver_id, period_type, period_start)
        DO UPDATE SET calculated_at = a.calculated_at;

    WITH eligible AS MATERIALIZED (
        SELECT start_time, trip_score
        FROM public.trips
        WHERE user_id = p_driver_id
            AND status = 'Completed'
            AND trip_score IS NOT NULL
            AND NOT is_excluded
            AND start_time <= p_as_of
    ), calendar_keys AS (
        -- Keep historical buckets even when their final trip is excluded.
        SELECT period_type, period_start
        FROM public.score_averages
        WHERE driver_id = p_driver_id
            AND period_type IN ('day', 'week', 'month', 'year')

        UNION

        SELECT p.period_type,
            date_trunc(
                p.period_type,
                e.start_time AT TIME ZONE 'America/Toronto'
            ) AT TIME ZONE 'America/Toronto'
        FROM eligible e
        CROSS JOIN (
            VALUES ('day'), ('week'), ('month'), ('year')
        ) p(period_type)

        UNION

        SELECT p.period_type,
            date_trunc(
                p.period_type,
                p_as_of AT TIME ZONE 'America/Toronto'
            ) AT TIME ZONE 'America/Toronto'
        FROM (
            VALUES ('day'), ('week'), ('month'), ('year')
        ) p(period_type)
    ), periods AS (
        SELECT period_type, period_start,
            (
                period_start AT TIME ZONE 'America/Toronto' +
                CASE period_type
                    WHEN 'day' THEN interval '1 day'
                    WHEN 'week' THEN interval '1 week'
                    WHEN 'month' THEN interval '1 month'
                    ELSE interval '1 year'
                END
            ) AT TIME ZONE 'America/Toronto' AS period_end
        FROM calendar_keys

        UNION ALL

        SELECT 'last_30_days', rolling_start, p_as_of

        UNION ALL

        SELECT 'all_time',
            '1970-01-01T00:00:00Z'::timestamptz, p_as_of
    )
    INSERT INTO public.score_averages
        (driver_id, period_type, period_start,
         average_score, trip_count, calculated_at)
    SELECT p_driver_id, p.period_type, p.period_start,
        round(avg(e.trip_score), 2),
        count(e.trip_score)::integer,
        p_as_of
    FROM periods p
    LEFT JOIN eligible e ON
        p.period_type = 'all_time'
        OR (
            e.start_time >= p.period_start
            AND (
                e.start_time < p.period_end
                OR (
                    p.period_type = 'last_30_days'
                    AND e.start_time = p.period_end
                )
            )
        )
    GROUP BY p.period_type, p.period_start
    ON CONFLICT (driver_id, period_type, period_start)
    DO UPDATE SET
        average_score = EXCLUDED.average_score,
        trip_count = EXCLUDED.trip_count,
        calculated_at = EXCLUDED.calculated_at;

    -- Keep only the current rolling window.
    DELETE FROM public.score_averages
    WHERE driver_id = p_driver_id
        AND period_type = 'last_30_days'
        AND period_start <> rolling_start;
END $$;

REVOKE ALL ON FUNCTION
    public.recompute_score_averages(UUID, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.recompute_score_averages(UUID, TIMESTAMPTZ)
    TO service_role;

CREATE FUNCTION public.refresh_averages_after_trip_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
    drivers UUID[];
    target UUID;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF ROW(
            OLD.user_id, OLD.start_time, OLD.status,
            OLD.trip_score, OLD.is_excluded
        ) IS NOT DISTINCT FROM ROW(
            NEW.user_id, NEW.start_time, NEW.status,
            NEW.trip_score, NEW.is_excluded
        ) THEN
            RETURN NULL;
        END IF;

        drivers := ARRAY[OLD.user_id, NEW.user_id];

    ELSIF TG_OP = 'INSERT' THEN
        drivers := ARRAY[NEW.user_id];

    ELSE
        drivers := ARRAY[OLD.user_id];
    END IF;

    FOR target IN
        SELECT DISTINCT u.id
        FROM unnest(drivers) u(id)
        WHERE u.id IS NOT NULL
        ORDER BY u.id
    LOOP
        PERFORM public.recompute_score_averages(target);
    END LOOP;

    -- Errors propagate: trip changes and averages roll back together.
    RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.refresh_averages_after_trip_change()
    FROM PUBLIC, anon, authenticated;

CREATE TRIGGER refresh_score_averages
    AFTER INSERT OR UPDATE OR DELETE ON public.trips
    FOR EACH ROW
    EXECUTE FUNCTION public.refresh_averages_after_trip_change();

-- Calculate initial averages without changing existing trip scores.
DO $$
DECLARE
    target UUID;
BEGIN
    FOR target IN
        SELECT DISTINCT user_id
        FROM public.trips
        WHERE user_id IS NOT NULL
        ORDER BY user_id
    LOOP
        PERFORM public.recompute_score_averages(target);
    END LOOP;
END $$;

COMMIT;
