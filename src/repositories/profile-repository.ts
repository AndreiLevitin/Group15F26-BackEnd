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

        const { error: driverError } = await client
            .from('drivers')
            .upsert(
                {
                    user_id: access.userId,
                    name: update.name,
                    email: update.email,
                    licence_no: update.licenceNo,
                },
                { onConflict: 'user_id' },
            );
        if (driverError) throw new Error(`Could not save profile: ${driverError.message}`);

        let vehicleId: string | null = null;
        if (update.vehicle) {
            const { data, error } = await client
                .from('vehicles')
                .upsert(
                    {
                        driver_id: access.userId,
                        make: update.vehicle.make,
                        model: update.vehicle.model,
                        year: update.vehicle.year,
                        plate_no: update.vehicle.plateNo,
                    },
                    { onConflict: 'driver_id' },
                )
                .select('vehicle_id')
                .single();
            if (error) throw new Error(`Could not save vehicle: ${error.message}`);
            vehicleId = (data as { vehicle_id: string }).vehicle_id;
        } else {
            const current = await profileRepository.findProfile(access);
            vehicleId = current.vehicle ? current.vehicle.vehicleId : null;
        }

        if (update.policy) {
            const { data: existing, error: readError } = await client
                .from('policies')
                .select('policy_no')
                .eq('driver_id', access.userId)
                .maybeSingle();
            if (readError) throw new Error(`Could not read policy: ${readError.message}`);

            if (existing) {
                // Update by driver, not by policy number, so a corrected
                // policy number changes the same row instead of adding one.
                const { error } = await client
                    .from('policies')
                    .update({
                        policy_no: update.policy.policyNo,
                        vehicle_id: vehicleId,
                        insurer: update.policy.insurer,
                        status: update.policy.status,
                    })
                    .eq('driver_id', access.userId);
                if (error) throw new Error(`Could not save policy: ${error.message}`);
            } else {
                const { error } = await client.from('policies').insert({
                    policy_no: update.policy.policyNo,
                    driver_id: access.userId,
                    vehicle_id: vehicleId,
                    insurer: update.policy.insurer,
                    status: update.policy.status,
                });
                if (error) throw new Error(`Could not save policy: ${error.message}`);
            }
        }

        return profileRepository.findProfile(access);
    },
};