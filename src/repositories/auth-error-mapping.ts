// How Supabase Auth errors map to this API's answers. Kept free of the
// Supabase client so the rules can be unit tested (tests/auth-error-mapping.test.ts).
import type { AuthFailure } from '../types/auth.js';

/** The parts of a Supabase AuthError these rules look at. */
export interface AuthErrorLike {
    status?: number | undefined;
    code?: string | undefined;
}

const isClientError = (error: AuthErrorLike) =>
    error.status !== undefined && error.status >= 400 && error.status < 500;

// A 429 is a 4xx, but it is temporary and says nothing about the caller's
// credentials or tokens. Every rule below checks it before treating other
// 4xx answers as "invalid" (AB#77 review).
export function isRateLimited(error: AuthErrorLike): boolean {
    return error.status === 429 || error.code === 'over_request_rate_limit';
}

/** Sign-up and sign-in: a known failure, or null for an unexpected error. */
export function expectedFailure(error: AuthErrorLike): AuthFailure | null {
    if (isRateLimited(error)) return 'rate_limited';
    switch (error.code) {
        case 'email_exists':
        case 'user_already_exists':
            return 'email_already_registered';
        case 'email_address_invalid':
            return 'invalid_email';
        case 'weak_password':
            return 'weak_password';
        case 'invalid_credentials':
            return 'invalid_credentials';
        case 'refresh_token_not_found':
        case 'refresh_token_already_used':
        case 'session_not_found':
        case 'session_expired':
            return 'invalid_refresh_token';
        default:
            return null;
    }
}

/** Refresh: any other 4xx means the refresh token cannot be used. */
export function refreshFailure(error: AuthErrorLike): AuthFailure | null {
    return expectedFailure(error) ?? (isClientError(error) ? 'invalid_refresh_token' : null);
}

/** Verifying an access token. 'unavailable' means Auth could not answer. */
export function tokenCheckFailure(error: AuthErrorLike): 'rate_limited' | 'invalid' | 'unavailable' {
    if (isRateLimited(error)) return 'rate_limited';
    return isClientError(error) ? 'invalid' : 'unavailable';
}
