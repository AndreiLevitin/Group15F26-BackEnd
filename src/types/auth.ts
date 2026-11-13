export const minimumPasswordLength = 8;

export interface AuthCredentials {
    email: string;
    password: string;
}

export interface AuthUser {
    id: string;
    email: string;
}

export interface AuthSession {
    accessToken: string;
    refreshToken: string;
    /** Unix time in seconds when the access token expires. */
    expiresAt: number;
}

export interface AuthResponse {
    user: AuthUser;
    session: AuthSession;
}

export type AuthErrorCode =
    | 'invalid_request'
    | 'invalid_email'
    | 'password_too_short'
    | 'weak_password'
    | 'email_already_registered'
    | 'invalid_credentials'
    | 'rate_limited'
    | 'auth_unavailable';

export interface AuthErrorResponse {
    error: AuthErrorCode;
    message: string;
}

/** Expected auth failures. Anything else is thrown as an unexpected error. */
export type AuthFailure = Exclude<
    AuthErrorCode,
    'invalid_request' | 'password_too_short' | 'auth_unavailable'
>;

export type AuthResult =
    | { ok: true; auth: AuthResponse }
    | { ok: false; reason: AuthFailure };
