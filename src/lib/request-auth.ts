// Composition root for request authentication (AB#77): the one place the
// token check is wired to Supabase Auth. Endpoints import `authenticate`.
import { verifyAccessToken } from '../repositories/auth-repository.ts';
import { createAuthenticator } from '../services/request-auth.ts';

export const authenticate = createAuthenticator(verifyAccessToken);
