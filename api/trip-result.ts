import { authenticate } from '../src/lib/request-auth.ts';
import { findTripResult } from '../src/repositories/trip-result-repository.js';
import { createTripResultHandler } from '../src/services/trip-result.js';

export const GET = createTripResultHandler(findTripResult, authenticate);
