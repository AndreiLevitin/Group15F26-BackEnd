/** Column lists for the profile tables (database/008_profile_tables.sql). */
export const driverFields = 'user_id, name, email, licence_no';
export const vehicleFields = 'vehicle_id, driver_id, make, model, year, plate_no';
export const policyFields = 'policy_no, driver_id, vehicle_id, insurer, status';

/** A driver's own profile row (Story 101, report Section 9). */
export interface Driver {
    userId: string;
    name: string;
    email: string;
    licenceNo: string | null;
}

/** The one vehicle on a driver's profile. */
export interface Vehicle {
    vehicleId: string;
    driverId: string;
    make: string | null;
    model: string | null;
    year: number | null;
    plateNo: string | null;
}

/** The one insurance policy on a driver's profile. */
export interface Policy {
    policyNo: string;
    driverId: string;
    vehicleId: string | null;
    insurer: string | null;
    status: string | null;
}

/** Everything the Profile screen shows for the signed-in driver. */
export interface Profile {
    driver: Driver | null;
    vehicle: Vehicle | null;
    policy: Policy | null;
}

/** The vehicle fields a driver can edit. */
export interface VehicleUpdate {
    make: string | null;
    model: string | null;
    year: number | null;
    plateNo: string | null;
}

/** The policy fields a driver can edit. */
export interface PolicyUpdate {
    policyNo: string;
    insurer: string | null;
    status: string | null;
}

/** Body of POST /api/profile: the full profile as edited on the screen. */
export interface ProfileUpdate {
    name: string;
    email: string;
    licenceNo: string | null;
    vehicle: VehicleUpdate | null;
    policy: PolicyUpdate | null;
}
