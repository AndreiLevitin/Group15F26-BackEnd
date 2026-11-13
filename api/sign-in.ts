import { signInWithPassword } from '../src/repositories/auth-repository.js';
import { createSignInHandler } from '../src/services/auth.js';

export const POST = createSignInHandler(signInWithPassword);
