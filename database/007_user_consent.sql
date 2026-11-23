-- 007_user_consent.sql — AB#106
-- Run once in the Supabase SQL editor, as owner, after migrations 001-006.

-- Stores the driver's consent to driving-data collection on the account
-- itself (Story 105). One row per account: the row existing IS the consent,
-- and consented_at records when it was given. No row means no consent, and
-- no trip data may be collected for that account.

-- Only the backend touches this table (service role), the same pattern as
-- trip completion: the API verifies the caller's access token first, then
-- reads or writes consent for that user id.

BEGIN;

CREATE TABLE public.user_consent (
                                     user_id UUID PRIMARY KEY REFERENCES auth.users (id),
                                     consented_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_consent ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_consent FROM anon, authenticated;
GRANT ALL ON public.user_consent TO service_role;

COMMIT;