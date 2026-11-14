-- AB#77: row-level security for trip ownership.
-- Run AFTER migrations 001–006 in a disposable/test Supabase SQL editor as owner.
-- Acts as two signed-in users and an anonymous caller. Every change rolls back.
BEGIN;

-- Two throwaway accounts and an unowned (pre-account) trip.
INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-4000-8000-00000000000a', 'rls-a@example.test'),
    ('00000000-0000-4000-8000-00000000000b', 'rls-b@example.test');
INSERT INTO public.trips (trip_id, status, end_time)
    VALUES ('00000000-0000-4000-8000-0000000000ff', 'Completed', now());

CREATE TEMP TABLE rls_ids (name TEXT PRIMARY KEY, id UUID) ON COMMIT DROP;
GRANT ALL ON rls_ids TO authenticated, anon;

-- User A starts a trip and adds a sample.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
DO $$
DECLARE trip UUID;
BEGIN
    INSERT INTO public.trips (user_id, status)
        VALUES ('00000000-0000-4000-8000-00000000000a', 'Active')
        RETURNING trip_id INTO trip;
    INSERT INTO rls_ids VALUES ('a_trip', trip);
    INSERT INTO public.trip_data_points (trip_id, recorded_at, acceleration)
        VALUES (trip, now(), 0);

    IF (SELECT count(*) FROM public.trips) <> 1 THEN
        RAISE EXCEPTION 'TEST: A must see only their own trip, not the unowned one';
    END IF;

    BEGIN
        INSERT INTO public.trips (user_id, status)
            VALUES ('00000000-0000-4000-8000-00000000000b', 'Active');
        RAISE EXCEPTION 'TEST: A must not create a trip owned by B';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        INSERT INTO public.trips (user_id, status, trip_score)
            VALUES ('00000000-0000-4000-8000-00000000000a', 'Active', 100);
        RAISE EXCEPTION 'TEST: A must not supply a trip score';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        INSERT INTO public.trips (user_id, status)
            VALUES ('00000000-0000-4000-8000-00000000000a', 'Active');
        RAISE EXCEPTION 'TEST: A must not have two active trips';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    BEGIN
        UPDATE public.trips SET trip_score = 100 WHERE trip_id = trip;
        RAISE EXCEPTION 'TEST: A must not update a trip';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;

-- User B cannot see, add to, or clear A's trip, and can start their own.
SELECT set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
DO $$
DECLARE a_trip UUID := (SELECT id FROM rls_ids WHERE name = 'a_trip');
BEGIN
    IF EXISTS (SELECT 1 FROM public.trips WHERE trip_id = a_trip) THEN
        RAISE EXCEPTION 'TEST: B must not see A''s trip';
    END IF;
    IF EXISTS (SELECT 1 FROM public.trip_data_points WHERE trip_id = a_trip) THEN
        RAISE EXCEPTION 'TEST: B must not see A''s samples';
    END IF;

    BEGIN
        INSERT INTO public.trip_data_points (trip_id, recorded_at, acceleration)
            VALUES (a_trip, now(), 0);
        RAISE EXCEPTION 'TEST: B must not add samples to A''s trip';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    DELETE FROM public.trip_data_points WHERE trip_id = a_trip;
    IF FOUND THEN RAISE EXCEPTION 'TEST: B must not delete A''s samples'; END IF;

    -- A's active trip does not block B (one active trip per account).
    INSERT INTO public.trips (user_id, status)
        VALUES ('00000000-0000-4000-8000-00000000000b', 'Active');
END $$;

-- Anonymous callers see nothing and can write nothing.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
    BEGIN
        PERFORM 1 FROM public.trips;
        RAISE EXCEPTION 'TEST: anon must not read trips';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM 1 FROM public.trip_data_points;
        RAISE EXCEPTION 'TEST: anon must not read samples';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;

-- Back as owner: A's sample survived B's delete attempt.
RESET ROLE;
DO $$
BEGIN
    IF (SELECT count(*) FROM public.trip_data_points
        WHERE trip_id = (SELECT id FROM rls_ids WHERE name = 'a_trip')) <> 1 THEN
        RAISE EXCEPTION 'TEST: A''s sample must be untouched';
    END IF;
END $$;

SELECT 'trip ownership RLS checks passed' AS result;
ROLLBACK;
