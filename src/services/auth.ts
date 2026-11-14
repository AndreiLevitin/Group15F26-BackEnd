import {
    minimumPasswordLength,
    type AuthCredentials,
    type AuthErrorCode,
    type AuthResult,
} from '../types/auth.ts';

type Authenticate = (credentials: AuthCredentials) => Promise<AuthResult>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const errors: Record<AuthErrorCode, { status: number; message: string }> = {
    invalid_request: { status: 400, message: 'Email and password are required.' },
    invalid_email: { status: 400, message: 'Enter a valid email address.' },
    password_too_short: {
        status: 400,
        message: `Password must be at least ${minimumPasswordLength} characters.`,
    },
    weak_password: { status: 400, message: 'Password does not meet the requirements.' },
    email_already_registered: {
        status: 409,
        message: 'An account with this email already exists. Sign in instead.',
    },
    invalid_credentials: { status: 401, message: 'Incorrect email or password.' },
    invalid_refresh_token: { status: 401, message: 'Your session has ended. Sign in again.' },
    rate_limited: { status: 429, message: 'Too many attempts. Wait a moment and try again.' },
    auth_unavailable: { status: 503, message: 'Sign-in is unavailable right now. Try again later.' },
};

function json(body: unknown, status: number) {
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function errorResponse(code: AuthErrorCode, messageOverride?: string) {
    const { status, message } = errors[code];
    return json({ error: code, message: messageOverride ?? message }, status);
}

async function readCredentials(request: Request): Promise<AuthCredentials | AuthErrorCode> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return 'invalid_request';
    }
    if (!body || typeof body !== 'object') return 'invalid_request';

    const { email, password } = body as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
        return 'invalid_request';
    }

    const trimmedEmail = email.trim();
    if (!emailPattern.test(trimmedEmail)) return 'invalid_email';

    return { email: trimmedEmail, password };
}

function createAuthHandler(
    authenticate: Authenticate,
    successStatus: number,
    enforcePasswordRule: boolean,
    action: string,
) {
    return async function POST(request: Request): Promise<Response> {
        const credentials = await readCredentials(request);
        if (typeof credentials === 'string') return errorResponse(credentials);

        // The length rule applies to new passwords only, so sign-in always
        // answers with the same generic error for any wrong password.
        if (enforcePasswordRule && credentials.password.length < minimumPasswordLength) {
            return errorResponse('password_too_short');
        }

        try {
            const result = await authenticate(credentials);
            if (!result.ok) return errorResponse(result.reason);
            return json(result.auth, successStatus);
        } catch (error) {
            console.error(`Unexpected error during ${action}:`, error);
            return errorResponse('auth_unavailable');
        }
    };
}

export function createSignUpHandler(createAccount: Authenticate) {
    return createAuthHandler(createAccount, 201, true, 'sign-up');
}

export function createSignInHandler(signIn: Authenticate) {
    return createAuthHandler(signIn, 200, false, 'sign-in');
}

/** POST /api/refresh-session (AB#77): swaps a refresh token for a new session. */
export function createRefreshSessionHandler(refresh: (refreshToken: string) => Promise<AuthResult>) {
    return async function POST(request: Request): Promise<Response> {
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            body = null;
        }
        const refreshToken = body && typeof body === 'object'
            ? (body as Record<string, unknown>).refreshToken
            : undefined;
        if (typeof refreshToken !== 'string' || !refreshToken) {
            return errorResponse('invalid_request', 'refreshToken is required.');
        }

        try {
            const result = await refresh(refreshToken);
            if (!result.ok) return errorResponse(result.reason);
            return json(result.auth, 200);
        } catch (error) {
            console.error('Unexpected error during session refresh:', error);
            return errorResponse('auth_unavailable');
        }
    };
}
