import { preflight, withCors } from '../src/lib/cors.ts';
import { signInWithPassword } from '../src/repositories/auth-repository.js';
import { createSignInHandler } from '../src/services/auth.js';

const handlePOST = createSignInHandler(signInWithPassword);

export const POST = withCors(handlePOST);
export const OPTIONS = preflight;
