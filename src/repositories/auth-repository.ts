import type { Session } from '@supabase/supabase-js';
import { createSignInClient, supabase } from '../lib/supabase.js';
import type { AuthCredentials, AuthResult } from '../types/auth.js';
import { AuthRateLimitedError } from '../types/auth-errors.ts';
import { expectedFailure, refreshFailure, tokenCheckFailure } from './auth-error-mapping.ts';

function toAuthResult(session: Session): AuthResult {
    const email = session.user.email;
    if (!email) throw new Error('Signed-in user has no email address');

    return {
        ok: true,
        auth: {
            user: { id: session.user.id, email },
            session: {
                accessToken: session.access_token,
                refreshToken: session.refresh_token,
                expiresAt: session.expires_at
                    ?? Math.floor(Date.now() / 1000) + session.expires_in,
            },
        },
    };
}

export async function signInWithPassword(credentials: AuthCredentials): Promise<AuthResult> {
    const { data, error } = await createSignInClient().auth.signInWithPassword(credentials);

    if (error) {
        const reason = expectedFailure(error);
        if (reason) return { ok: false, reason };
        throw new Error(`Could not sign in: ${error.message}`);
    }
    if (!data.session) throw new Error('Sign-in returned no session');

    return toAuthResult(data.session);
}

export async function refreshSession(refreshToken: string): Promise<AuthResult> {
    const { data, error } = await createSignInClient().auth.refreshSession({
        refresh_token: refreshToken,
    });

    if (error) {
        const reason = refreshFailure(error);
        if (reason) return { ok: false, reason };
        throw new Error(`Could not refresh session: ${error.message}`);
    }
    if (!data.session) throw new Error('Refresh returned no session');

    return toAuthResult(data.session);
}

/**
 * Asks Supabase Auth who an access token belongs to. Returns null when the
 * token is invalid, expired or revoked. Throws AuthRateLimitedError when Auth
 * is rate-limiting (the token may well be fine), and a plain Error when Auth
 * cannot be reached.
 */
export async function verifyAccessToken(accessToken: string): Promise<{ id: string } | null> {
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error) {
        switch (tokenCheckFailure(error)) {
            case 'rate_limited': throw new AuthRateLimitedError();
            case 'invalid': return null;
            case 'unavailable': break;
        }
        throw new Error(`Could not verify access token: ${error.message}`);
    }
    return data.user ? { id: data.user.id } : null;
}

/**
 * Bug 89: ends the session this access token belongs to, so the token and
 * its refresh token stop working everywhere. Only this session ('local');
 * the user's other devices stay signed in.
 *
 * A token Supabase already rejects means the session is already over, which
 * is the outcome wanted, so it counts as success. Throws AuthRateLimitedError
 * when rate-limited and a plain Error when Auth cannot be reached.
 */
export async function revokeSession(accessToken: string): Promise<void> {
    const { error } = await supabase.auth.admin.signOut(accessToken, 'local');
    if (!error) return;

    switch (tokenCheckFailure(error)) {
        case 'rate_limited': throw new AuthRateLimitedError();
        case 'invalid': return;
        case 'unavailable': break;
    }
    throw new Error(`Could not revoke session: ${error.message}`);
}

// Email confirmation is off for this project (AB#75): accounts are created
// already confirmed, so sign-up signs the user straight in. Using the admin
// API also means a duplicate email reports `email_exists` instead of the
// silent success Supabase gives public sign-ups when confirmation is on.
export async function createAccount(credentials: AuthCredentials): Promise<AuthResult> {
    const { error } = await supabase.auth.admin.createUser({
        email: credentials.email,
        password: credentials.password,
        email_confirm: true,
    });

    if (error) {
        const reason = expectedFailure(error);
        if (reason) return { ok: false, reason };
        throw new Error(`Could not create account: ${error.message}`);
    }

    return signInWithPassword(credentials);
}
