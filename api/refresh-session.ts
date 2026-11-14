import { refreshSession } from '../src/repositories/auth-repository.js';
import { createRefreshSessionHandler } from '../src/services/auth.js';

export const POST = createRefreshSessionHandler(refreshSession);
