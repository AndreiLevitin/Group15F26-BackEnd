-- 003_create_trip_data_points.sql
-- Creates the trip_data_points table: one row per sample
-- recorded during a trip, GPS rows and motion rows alike.
-- The column names match the backend code that reads this
-- table: the recorded trip repository and the scoring
-- service select trip_id, recorded_at, latitude, longitude
-- and speed_kmh. (The Phase 2 report prints ts, lat and
-- lon for this table; the names here follow the code,
-- which is what actually runs against the table.)
-- speed_kmh, latitude and longitude are nullable because
-- motion rows carry no speed or location. recorded_at and
-- acceleration are filled on every row, so they are
-- NOT NULL.

CREATE TABLE trip_data_points (
                                  sample_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                                  trip_id UUID NOT NULL REFERENCES trips (trip_id),
                                  recorded_at TIMESTAMPTZ NOT NULL,
                                  speed_kmh NUMERIC,
                                  acceleration NUMERIC NOT NULL,
                                  latitude NUMERIC,
                                  longitude NUMERIC
);