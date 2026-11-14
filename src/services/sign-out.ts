import { AuthRateLimitedError } from '../types/auth-errors.ts';
import { authUnavailable, rateLimited, readBearerToken, unauthorized } from './request-auth.ts';

/**
 * POST /api/sign-out (Bug 89). Revokes the session behind the caller's access
 * token, so that token and its refresh token stop working on the backend,
 * not only on the phone that signed out.
 *
 * Safe to repeat: an already-ended session also answers 204. A rate limit
 * (429) or an Auth outage (503) means the session may still be live, so the
 * client should still clear its own tokens and may retry later.
 */
export function createSignOutHandler(revoke: (accessToken: string) => Promise<void>) {
    return async function POST(request: Request): Promise<Response> {
        const accessToken = readBearerToken(request);
        if (!accessToken) return unauthorized();

        try {
            await revoke(accessToken);
            return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
        } catch (error) {
            if (error instanceof AuthRateLimitedError) return rateLimited();
            console.error('Could not revoke session:', error);
            return authUnavailable();
        }
    };
}
