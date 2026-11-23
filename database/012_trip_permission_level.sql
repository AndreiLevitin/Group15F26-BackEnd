-- 012_trip_permission_level.sql — AB#207
-- Run once in the Supabase SQL editor, as owner, after migrations 001–011.
--
-- Stores which location permission each trip ran under, so trips can be
-- sorted and checked by it. The app asks for the permission before the
-- trip is created and sends the answer with the start-trip request; the
-- backend stores it on the trip row.

BEGIN;

-- 1. The column. Trips recorded before this keep NULL, which says
-- exactly that: no level was stored for them.
ALTER TABLE public.trips
    ADD COLUMN permission_level TEXT
        CHECK (permission_level IN ('background', 'foreground', 'approximate', 'denied'));

-- 2. The insert grant in 006 named only user_id and status. Trips are
-- inserted with the caller's token, so the new column has to be
-- added to that grant or the insert fails.
GRANT INSERT (user_id, status, permission_level) ON public.trips TO authenticated;

COMMIT;-- 012_trip_permission_level.sql — AB#207
-- Run once in the Supabase SQL editor, as owner, after migrations 001–011.
--
-- Stores which location permission each trip ran under, so trips can be
-- sorted and checked by it. The app asks for the permission before the
-- trip is created and sends the answer with the start-trip request; the
-- backend stores it on the trip row.
