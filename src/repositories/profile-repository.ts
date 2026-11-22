// Profile records for signed-in accounts (AB#102, Story 101).
// Queries run with the caller's access token (the AB#77 pattern), so the
// row-level policies in database/008_profile_tables.sql apply: an account
// can only ever read or write its own driver, vehicle, and policy rows.
import { createUserClient } from '../lib/supabase.js';
import type { TripAccess } from '../types/auth.js';
import {
    driverFields,
    policyFields,
    vehicleFields,
    type Driver,
    type Policy,
    type Profile,
    type ProfileUpdate,
    type Vehicle,
} from '../types/profile.js';

export interface ProfileRepository {
    /** The signed-in driver's profile, with nulls for the parts not yet saved. */
    findProfile(access: TripAccess): Promise<Profile>;
    /**
     * Saves the signed-in driver's profile and returns it as stored.
     * Saving twice updates the same rows: the driver row is keyed by the
     * account id, and there is one vehicle and one policy per driver.
     */
    saveProfile(access: TripAccess, update: ProfileUpdate): Promise<Profile>;
}

interface DriverRow {
    user_id: string;
    name: string;
    email: string;
    licence_no: string | null;
}

interface VehicleRow {
    vehicle_id: string;
    driver_id: string;
    make: string | null;
    model: string | null;
    year: number | null;
    plate_no: string | null;
}

interface PolicyRow {
    policy_no: string;
    driver_id: string;
    vehicle_id: string | null;
    insurer: string | null;
    status: string | null;
}

function toDriver(row: DriverRow): Driver {
    return {
        userId: row.user_id,
        name: row.name,
        email: row.email,
        licenceNo: row.licence_no,
    };
}

function toVehicle(row: VehicleRow): Vehicle {
    return {
        vehicleId: row.vehicle_id,
        driverId: row.driver_id,
        make: row.make,
        model: row.model,
        year: row.year,
        plateNo: row.plate_no,
    };
}

function toPolicy(row: PolicyRow): Policy {
    return {
        policyNo: row.policy_no,
        driverId: row.driver_id,
        vehicleId: row.vehicle_id,
        insurer: row.insurer,
        status: row.status,
    };
}

export const profileRepository: ProfileRepository = {
    async findProfile(access) {
        const client = createUserClient(access.accessToken);

        const { data: driverData, error: driverError } = await client
            .from('drivers')
            .select(driverFields)
            .eq('user_id', access.userId)
            .maybeSingle();
        if (driverError) throw new Error(`Could not read profile: ${driverError.message}`);

        const { data: vehicleData, error: vehicleError } = await client
            .from('vehicles')
            .select(vehicleFields)
            .eq('driver_id', access.userId)
            .maybeSingle();
        if (vehicleError) throw new Error(`Could not read vehicle: ${vehicleError.message}`);

        const { data: policyData, error: policyError } = await client
            .from('policies')
            .select(policyFields)
            .eq('driver_id', access.userId)
            .maybeSingle();
        if (policyError) throw new Error(`Could not read policy: ${policyError.message}`);

        return {
            driver: driverData ? toDriver(driverData as DriverRow) : null,
            vehicle: vehicleData ? toVehicle(vehicleData as VehicleRow) : null,
            policy: policyData ? toPolicy(policyData as PolicyRow) : null,
        };
    },

    async saveProfile(access, update) {
        const client = createUserClient(access.accessToken);

// One database call, so the driver, vehicle, and policy writes
// land together or not at all (save_profile, migration 011).
        const { error } = await client.rpc('save_profile', {
            p_name: update.name,
            p_email: update.email,
            p_licence_no: update.licenceNo,
            p_vehicle: update.vehicle,
            p_policy: update.policy,
        });

        if (error) throw new Error(`Could not save profile: ${error.message}`);

        return profileRepository.findProfile(access);
    },
};