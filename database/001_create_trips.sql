-- This script was executed manually in Supabase to create the database table.
-- It is kept for reference and is not executed when the application starts.
CREATE TABLE public.trips (
    trip_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    end_time TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Processing', 'Completed', 'Invalid')),
    distance_km NUMERIC(10, 3),
    trip_score NUMERIC(5, 2)
    CHECK (trip_score BETWEEN 0 AND 100)
);

ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
