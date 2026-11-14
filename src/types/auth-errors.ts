/**
 * Supabase Auth is rate-limiting the backend. This is temporary and says
 * nothing about whether the caller's token or session is valid, so it must
 * never be reported as 401 (AB#77 review).
 */
export class AuthRateLimitedError extends Error {
    constructor() {
        super('Supabase Auth rate limit reached');
        this.name = 'AuthRateLimitedError';
    }
}
