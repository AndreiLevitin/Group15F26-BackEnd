import { revokeSession } from '../src/repositories/auth-repository.ts';
import { createSignOutHandler } from '../src/services/sign-out.ts';

export const POST = createSignOutHandler(revokeSession);
