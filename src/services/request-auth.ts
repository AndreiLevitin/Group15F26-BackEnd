import type { TripAccess } from '../types/auth.js';

export type VerifyAccessToken = (accessToken: string) => Promise<{ id: string } | null>;

export type AuthCheck =
    | { ok: true; access: TripAccess }
    | { ok: false; response: Response };

export type Authenticate = (request: Request) => Promise<AuthCheck>;

const bearerPattern = /^Bearer ([A-Za-z0-9\-_.~+/]+=*)$/;

function unauthorized() {
    return Response.json(
        { error: 'unauthorized', message: 'Your session has ended. Sign in again.' },
        {
            status: 401,
            headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' },
        },
    );
}

/**
 * Builds the check every trip endpoint runs first (AB#77). The caller's
 * identity comes only from a verified `Authorization: Bearer <token>` header;
 * any user ID in the URL or body is never trusted.
 */
export function createAuthenticator(verify: VerifyAccessToken): Authenticate {
    return async function authenticate(request) {
        const match = bearerPattern.exec(request.headers.get('Authorization') ?? '');
        const accessToken = match?.[1];
        if (!accessToken) return { ok: false, response: unauthorized() };

        try {
            const user = await verify(accessToken);
            if (!user) return { ok: false, response: unauthorized() };
            return { ok: true, access: { userId: user.id, accessToken } };
        } catch (error) {
            console.error('Could not verify access token:', error);
            return {
                ok: false,
                response: Response.json(
                    { error: 'auth_unavailable', message: 'Sign-in is unavailable right now. Try again later.' },
                    { status: 503, headers: { 'Cache-Control': 'no-store' } },
                ),
            };
        }
    };
}
