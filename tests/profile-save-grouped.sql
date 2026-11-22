-- AB#102: a profile save lands completely or not at all.
-- Run against a test database after migrations 001-009.
-- Everything runs in one transaction and the file ends with ROLLBACK,
-- so the test leaves nothing behind.

BEGIN;

-- A throwaway driver account.
INSERT INTO auth.users (id)
    VALUES ('00000000-0000-0000-0000-000000001102');

-- Act as that driver: save_profile takes the driver from the token.
SELECT set_config(
    'request.jwt.claims',
    '{"sub": "00000000-0000-0000-0000-000000001102", "role": "authenticated"}',
    true
);

-- A full save stores the driver, the vehicle, and the policy.
SELECT public.save_profile(
    'Sam Driver',
    'sam@example.com',
    'D1234',
    '{"make": "Honda", "model": "Civic", "year": 2022, "plateNo": "ABC 123"}'::jsonb,
    '{"policyNo": "P-100", "insurer": "Acme", "status": "Active"}'::jsonb
);

DO $$
BEGIN
ASSERT (SELECT count(*) FROM public.drivers
    WHERE user_id = '00000000-0000-0000-0000-000000001102') = 1,
    'a full save should store the driver row';
ASSERT (SELECT count(*) FROM public.vehicles
    WHERE driver_id = '00000000-0000-0000-0000-000000001102') = 1,
    'a full save should store the vehicle row';
ASSERT (SELECT count(*) FROM public.policies
    WHERE driver_id = '00000000-0000-0000-0000-000000001102') = 1,
    'a full save should store the policy row';
END $$;

-- Start the failure case from an empty profile.
DELETE FROM public.policies
    WHERE driver_id = '00000000-0000-0000-0000-000000001102';
DELETE FROM public.vehicles
    WHERE driver_id = '00000000-0000-0000-0000-000000001102';
DELETE FROM public.drivers
    WHERE user_id = '00000000-0000-0000-0000-000000001102';

-- Force every policy write to fail.
CREATE OR REPLACE FUNCTION public.fail_the_policy_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
RAISE EXCEPTION 'forced policy failure for the test';
END;
$$;

CREATE TRIGGER fail_the_policy_write
    BEFORE INSERT OR UPDATE ON public.policies
    FOR EACH ROW EXECUTE FUNCTION public.fail_the_policy_write();

-- The same save now fails partway, at the policy write.
DO $$
BEGIN
BEGIN
PERFORM public.save_profile(
    'Sam Driver',
    'sam@example.com',
    'D1234',
    '{"make": "Honda", "model": "Civic", "year": 2022, "plateNo": "ABC 123"}'::jsonb,
    '{"policyNo": "P-100", "insurer": "Acme", "status": "Active"}'::jsonb
);
RAISE EXCEPTION 'the save should have failed when the policy write failed';
EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'the save should have failed when the policy write failed' THEN
    RAISE;
    END IF;
-- Any other error is the forced failure doing its job: the
-- save rolled back, which is what the asserts below check.
END;
END $$;

-- Nothing from the failed save may be stored.
DO $$
BEGIN
ASSERT (SELECT count(*) FROM public.drivers
    WHERE user_id = '00000000-0000-0000-0000-000000001102') = 0,
    'the driver row must not survive a failed save';
ASSERT (SELECT count(*) FROM public.vehicles
    WHERE driver_id = '00000000-0000-0000-0000-000000001102') = 0,
    'the vehicle row must not survive a failed save';
ASSERT (SELECT count(*) FROM public.policies
    WHERE driver_id = '00000000-0000-0000-0000-000000001102') = 0,
    'the policy row must not survive a failed save';
END $$;

ROLLBACK;
