import type { ProfileRepository } from '../repositories/profile-repository.ts';
import type {
    PolicyUpdate,
    ProfileUpdate,
    VehicleUpdate,
} from '../types/profile.ts';
import type { Authenticate } from './request-auth.ts';

/** A required text field, trimmed, or null when it is missing or blank. */
function readRequiredText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** An optional text field: a trimmed string, or null for anything else. */
function readOptionalText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** An optional whole number, or null for anything else. */
function readOptionalYear(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    return value;
}

function readVehicle(value: unknown): VehicleUpdate | null {
    if (typeof value !== 'object' || value === null) return null;
    const vehicle = value as Record<string, unknown>;
    return {
        make: readOptionalText(vehicle.make),
        model: readOptionalText(vehicle.model),
        year: readOptionalYear(vehicle.year),
        plateNo: readOptionalText(vehicle.plateNo),
    };
}

function readPolicy(value: unknown): PolicyUpdate | null | undefined {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object') return undefined;
    const policy = value as Record<string, unknown>;
    const policyNo = readRequiredText(policy.policyNo);
    if (!policyNo) return undefined;
    return {
        policyNo,
        insurer: readOptionalText(policy.insurer),
        status: readOptionalText(policy.status),
    };
}

/**
 * Reads the POST body as a profile update, or returns null when the body
 * cannot be one: the report (Section 4) requires a name and an email, and
 * a policy cannot be saved without its policy number.
 */
async function readProfileUpdate(request: Request): Promise<ProfileUpdate | null> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return null;
    }
    if (typeof body !== 'object' || body === null) return null;
    const fields = body as Record<string, unknown>;

    const name = readRequiredText(fields.name);
    const email = readRequiredText(fields.email);
    if (!name || !email) return null;

    const policy = readPolicy(fields.policy);
    if (policy === undefined) return null;

    return {
        name,
        email,
        licenceNo: readOptionalText(fields.licenceNo),
        vehicle: readVehicle(fields.vehicle),
        policy,
    };
}

/** GET /api/profile: the signed-in driver's profile, vehicle, and policy. */
export function createProfileReadHandler(
    authenticate: Authenticate,
    profile: Pick<ProfileRepository, 'findProfile'>,
) {
    return async function GET(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        try {
            const found = await profile.findProfile(auth.access);
            return Response.json(found, {
                headers: { 'Cache-Control': 'no-store' },
            });
        } catch (error) {
            console.error('Failed to read profile:', error);
            return Response.json(
                { error: 'profile_unavailable' },
                { status: 503, headers: { 'Cache-Control': 'no-store' } },
            );
        }
    };
}

/** POST /api/profile: saves the signed-in driver's profile as edited. */
export function createProfileSaveHandler(
    authenticate: Authenticate,
    profile: Pick<ProfileRepository, 'saveProfile'>,
) {
    return async function POST(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        const update = await readProfileUpdate(request);
        if (!update) {
            return Response.json(
                { error: 'invalid_profile' },
                { status: 400, headers: { 'Cache-Control': 'no-store' } },
            );
        }

        try {
            const saved = await profile.saveProfile(auth.access, update);
            return Response.json(saved, {
                headers: { 'Cache-Control': 'no-store' },
            });
        } catch (error) {
            console.error('Failed to save profile:', error);
            return Response.json(
                { error: 'profile_unavailable' },
                { status: 503, headers: { 'Cache-Control': 'no-store' } },
            );
        }
    };
}
