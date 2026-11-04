-- Prevent concurrent start requests from creating more than one active trip.
CREATE UNIQUE INDEX IF NOT EXISTS trips_single_active_idx
    ON public.trips (status)
    WHERE status = 'Active';
