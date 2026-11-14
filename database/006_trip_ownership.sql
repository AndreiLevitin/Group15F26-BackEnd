-- 006_trip_ownership.sql — AB#77
-- Run once in the Supabase SQL editor, as owner, after migrations 001–005.
--
-- Gives every new trip an owning account and makes row-level security the
-- backstop for trip access. The backend runs user-facing trip queries with
-- the caller's access token, so these policies apply to them as well as to
-- anyone calling the Supabase API directly with a user token.
--
-- Pre-account trips: kept, with user_id NULL. RLS hides them from every
-- account (NULL never equals auth.uid()). The service role still sees them.
-- This is the reversible choice; the team decision is still to be recorded
-- on AB#77. To later delete or reassign them, act on `WHERE user_id IS NULL`.

BEGIN;

-- 1. Owner column. NO ACTION on delete: an account that owns trips cannot be
--    deleted until its trips are dealt with, so trip data is never silently
--    removed or orphaned.
ALTER TABLE public.trips
    ADD COLUMN user_id UUID REFERENCES auth.users (id);

CREATE INDEX trips_user_id_start_time_idx
    ON public.trips (user_id, start_time DESC);

-- 2. One active trip per account, instead of one in the whole system.
--    Unowned (NULL) trips are not constrained against each other.
DROP INDEX IF EXISTS public.trips_single_active_idx;
CREATE UNIQUE INDEX trips_single_active_per_user_idx
    ON public.trips (user_id)
    WHERE status = 'Active';

-- 3. Privileges. Supabase grants everything to anon and authenticated by
--    default; replace that with the minimum the app needs.
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_data_points ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.trips, public.trip_data_points FROM anon, authenticated;
GRANT ALL ON public.trips, public.trip_data_points TO service_role;

GRANT SELECT ON public.trips TO authenticated;
-- Only these columns can be supplied on insert: trip_id and start_time come
-- from their defaults, and end_time/distance/score can only be set by the
-- backend's service role.
GRANT INSERT (user_id, status) ON public.trips TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.trip_data_points TO authenticated;

-- 4. Policies. No UPDATE or DELETE policy on trips for users: ending and
--    scoring a trip is done by the backend only.
CREATE POLICY trips_select_own ON public.trips
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

CREATE POLICY trips_insert_own ON public.trips
    FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()) AND status = 'Active');

CREATE POLICY trip_data_points_select_own ON public.trip_data_points
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.trips t
        WHERE t.trip_id = trip_data_points.trip_id
          AND t.user_id = (SELECT auth.uid())
    ));

-- Samples can only be added to, or replaced on, the caller's own Active trip.
CREATE POLICY trip_data_points_insert_own_active ON public.trip_data_points
    FOR INSERT TO authenticated
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.trips t
        WHERE t.trip_id = trip_data_points.trip_id
          AND t.user_id = (SELECT auth.uid())
          AND t.status = 'Active'
    ));

CREATE POLICY trip_data_points_delete_own_active ON public.trip_data_points
    FOR DELETE TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.trips t
        WHERE t.trip_id = trip_data_points.trip_id
          AND t.user_id = (SELECT auth.uid())
          AND t.status = 'Active'
    ));

-- 5. The sample guard locks the trip row with FOR SHARE, which a signed-in
--    user has no privilege for. It only checks the trip's status, so let it
--    run with its owner's rights. search_path is already pinned in 004.
ALTER FUNCTION public.guard_trip_samples() SECURITY DEFINER;

COMMIT;
