import type { AuthError, Session } from '@supabase/supabase-js';
import { createSignInClient, supabase } from '../lib/supabase.js';
import type { AuthCredentials, AuthFailure, AuthResult } from '../types/auth.js';

function expectedFailure(error: AuthError): AuthFailure | null {
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
        case 'over_request_rate_limit':
            return 'rate_limited';
        default:
            return null;
    }
}

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
        const reason = expectedFailure(error);
        if (reason) return { ok: false, reason };
        // Any other client error means this refresh token cannot be used.
        if (error.status !== undefined && error.status >= 400 && error.status < 500) {
            return { ok: false, reason: 'invalid_refresh_token' };
        }
        throw new Error(`Could not refresh session: ${error.message}`);
    }
    if (!data.session) throw new Error('Refresh returned no session');

    return toAuthResult(data.session);
}

/**
 * Asks Supabase Auth who an access token belongs to. Returns null when the
 * token is invalid, expired or revoked; throws when Auth cannot be reached.
 */
export async function verifyAccessToken(accessToken: string): Promise<{ id: string } | null> {
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error) {
        if (error.status !== undefined && error.status >= 400 && error.status < 500) return null;
        throw new Error(`Could not verify access token: ${error.message}`);
    }
    return data.user ? { id: data.user.id } : null;
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
