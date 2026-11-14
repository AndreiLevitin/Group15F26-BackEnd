import { preflight, withCors } from '../src/lib/cors.ts';
import { refreshSession } from '../src/repositories/auth-repository.js';
import { createRefreshSessionHandler } from '../src/services/auth.js';

const handlePOST = createRefreshSessionHandler(refreshSession);

export const POST = withCors(handlePOST);
export const OPTIONS = preflight;
