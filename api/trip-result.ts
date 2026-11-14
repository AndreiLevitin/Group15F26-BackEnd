import { preflight, withCors } from '../src/lib/cors.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { findTripResult } from '../src/repositories/trip-result-repository.js';
import { createTripResultHandler } from '../src/services/trip-result.js';

const handleGET = createTripResultHandler(findTripResult, authenticate);

export const GET = withCors(handleGET);
export const OPTIONS = preflight;
