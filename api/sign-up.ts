import { createAccount } from '../src/repositories/auth-repository.js';
import { createSignUpHandler } from '../src/services/auth.js';

export const POST = createSignUpHandler(createAccount);
