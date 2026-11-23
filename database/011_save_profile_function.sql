-- AB#102. Apply once as owner after migration 008.
-- Saves a driver's profile, vehicle, and policy in one transaction, so a
-- profile save lands completely or not at all.
BEGIN;

CREATE OR REPLACE FUNCTION public.save_profile(
    p_name TEXT,
    p_email TEXT,
    p_licence_no TEXT,
    p_vehicle JSONB,
    p_policy JSONB
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_vehicle_id UUID;
BEGIN
IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'save_profile requires a signed-in driver';
    END IF;

INSERT INTO public.drivers (user_id, name, email, licence_no)
VALUES (v_user_id, p_name, p_email, p_licence_no)
    ON CONFLICT (user_id) DO UPDATE
                                 SET name = EXCLUDED.name,
                                 email = EXCLUDED.email,
                                 licence_no = EXCLUDED.licence_no;

IF p_vehicle IS NOT NULL THEN
    INSERT INTO public.vehicles (driver_id, make, model, year, plate_no)
    VALUES (
        v_user_id,
        p_vehicle ->> 'make',
        p_vehicle ->> 'model',
        (p_vehicle ->> 'year')::INTEGER,
        p_vehicle ->> 'plateNo'
    )
    ON CONFLICT (driver_id) DO UPDATE
        SET make = EXCLUDED.make,
     model = EXCLUDED.model,
     year = EXCLUDED.year,
     plate_no = EXCLUDED.plate_no
     RETURNING vehicle_id INTO v_vehicle_id;
ELSE
    SELECT vehicle_id INTO v_vehicle_id
    FROM public.vehicles
    WHERE driver_id = v_user_id;
    END IF;

IF p_policy IS NOT NULL THEN
    UPDATE public.policies
    SET policy_no = p_policy ->> 'policyNo',
    vehicle_id = v_vehicle_id,
    insurer = p_policy ->> 'insurer',
    status = p_policy ->> 'status'
    WHERE driver_id = v_user_id;

IF NOT FOUND THEN
    INSERT INTO public.policies (policy_no, driver_id, vehicle_id, insurer, status)
    VALUES (
        p_policy ->> 'policyNo',
        v_user_id,
        v_vehicle_id,
        p_policy ->> 'insurer',
        p_policy ->> 'status'
    );
    END IF;
END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_profile(TEXT, TEXT, TEXT, JSONB, JSONB) TO authenticated;

COMMIT;