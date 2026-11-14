import type { TripAccess } from '../types/auth.js';
import { AuthRateLimitedError } from '../types/auth-errors.ts';

export type VerifyAccessToken = (accessToken: string) => Promise<{ id: string } | null>;

export type AuthCheck =
    | { ok: true; access: TripAccess }
    | { ok: false; response: Response };

export type Authenticate = (request: Request) => Promise<AuthCheck>;

const bearerPattern = /^Bearer ([A-Za-z0-9\-_.~+/]+=*)$/;

/** The token from `Authorization: Bearer <token>`, or null if absent or malformed. */
export function readBearerToken(request: Request): string | null {
    return bearerPattern.exec(request.headers.get('Authorization') ?? '')?.[1] ?? null;
}

export function unauthorized() {
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
        const accessToken = readBearerToken(request);
        if (!accessToken) return { ok: false, response: unauthorized() };

        try {
            const user = await verify(accessToken);
            if (!user) return { ok: false, response: unauthorized() };
            return { ok: true, access: { userId: user.id, accessToken } };
        } catch (error) {
            // Temporary: the token may be fine, so this is not a 401 and the
            // client must not refresh or sign out because of it.
            if (error instanceof AuthRateLimitedError) return { ok: false, response: rateLimited() };
            console.error('Could not verify access token:', error);
            return { ok: false, response: authUnavailable() };
        }
    };
}

export function rateLimited() {
    return Response.json(
        { error: 'rate_limited', message: 'Too many requests. Wait a moment and try again.' },
        { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } },
    );
}

export function authUnavailable() {
    return Response.json(
        { error: 'auth_unavailable', message: 'Sign-in is unavailable right now. Try again later.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
}
