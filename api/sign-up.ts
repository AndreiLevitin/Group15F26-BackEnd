import { preflight, withCors } from '../src/lib/cors.ts';
import { createAccount } from '../src/repositories/auth-repository.js';
import { createSignUpHandler } from '../src/services/auth.js';

const handlePOST = createSignUpHandler(createAccount);

export const POST = withCors(handlePOST);
export const OPTIONS = preflight;
