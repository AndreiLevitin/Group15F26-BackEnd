-- 008_profile_tables.sql — AB#102
-- Run once in the Supabase SQL editor, as owner, after migrations 001-007.
--
-- Adds the profile tables from report Section 9: one driver row per
-- account, and one vehicle and one policy per driver. Row-level security
-- is the backstop for profile access, the same way 006 made it the
-- backstop for trip access: the backend runs profile queries with the
-- caller's access token, so a driver can only ever reach their own rows.

BEGIN;

-- 1. Tables. The driver row is keyed by the account id, so driver_id in
-- the other two tables is the account id as well.
CREATE TABLE public.drivers (
    user_id UUID PRIMARY KEY REFERENCES auth.users (id),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        licence_no TEXT
);

CREATE TABLE public.vehicles (
    vehicle_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES public.drivers (user_id),
        make TEXT,
        model TEXT,
        year INTEGER,
        plate_no TEXT,
    UNIQUE (driver_id)
);

CREATE TABLE public.policies (
    policy_no TEXT PRIMARY KEY,
    driver_id UUID NOT NULL REFERENCES public.drivers (user_id),
    vehicle_id UUID REFERENCES public.vehicles (vehicle_id),
        insurer TEXT,
        status TEXT,
    UNIQUE (driver_id)
);

-- 2. Privileges. Supabase grants everything to anon and authenticated by
-- default; replace that with the minimum the app needs.
ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.drivers, public.vehicles, public.policies FROM anon, authenticated;
GRANT ALL ON public.drivers, public.vehicles, public.policies TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.drivers, public.vehicles, public.policies TO authenticated;

-- 3. Policies. A driver can read and change only their own profile rows;
-- there is no delete, because profiles are corrected, not removed.
CREATE POLICY drivers_select_own ON public.drivers
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

CREATE POLICY drivers_insert_own ON public.drivers
    FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY drivers_update_own ON public.drivers
    FOR UPDATE TO authenticated
    USING (user_id = (SELECT auth.uid()));

CREATE POLICY vehicles_select_own ON public.vehicles
    FOR SELECT TO authenticated
    USING (driver_id = (SELECT auth.uid()));

CREATE POLICY vehicles_insert_own ON public.vehicles
    FOR INSERT TO authenticated
    WITH CHECK (driver_id = (SELECT auth.uid()));

CREATE POLICY vehicles_update_own ON public.vehicles
    FOR UPDATE TO authenticated
    USING (driver_id = (SELECT auth.uid()));

CREATE POLICY policies_select_own ON public.policies
    FOR SELECT TO authenticated
    USING (driver_id = (SELECT auth.uid()));

CREATE POLICY policies_insert_own ON public.policies
    FOR INSERT TO authenticated
    WITH CHECK (driver_id = (SELECT auth.uid()));

CREATE POLICY policies_update_own ON public.policies
    FOR UPDATE TO authenticated
    USING (driver_id = (SELECT auth.uid()));

COMMIT;
