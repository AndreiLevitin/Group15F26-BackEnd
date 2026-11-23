// Serves /api/sign-up, /api/sign-in, /api/sign-out and /api/refresh-session
// (see rewrites in vercel.json and src/lib/route-dispatch.ts).
import { preflight, withCors } from '../src/lib/cors.ts';
import { dispatch } from '../src/lib/route-dispatch.ts';
import {
    createAccount,
    refreshSession,
    revokeSession,
    signInWithPassword,
} from '../src/repositories/auth-repository.ts';
import {
    createRefreshSessionHandler,
    createSignInHandler,
    createSignUpHandler,
} from '../src/services/auth.ts';
import { createSignOutHandler } from '../src/services/sign-out.ts';

const handler = dispatch({
    'sign-up': {
        POST: withCors(createSignUpHandler(createAccount)),
        OPTIONS: preflight,
    },
    'sign-in': {
        POST: withCors(createSignInHandler(signInWithPassword)),
        OPTIONS: preflight,
    },
    // sign-out has never been CORS-wrapped; kept as is.
    'sign-out': {
        POST: createSignOutHandler(revokeSession),
    },
    'refresh-session': {
        POST: withCors(createRefreshSessionHandler(refreshSession)),
        OPTIONS: preflight,
    },
});

export const POST = handler;
export const OPTIONS = handler;
