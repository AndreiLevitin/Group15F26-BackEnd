import { preflight, withCors } from '../src/lib/cors.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { findUserTripHistory } from '../src/repositories/trip-history-repository.js';
import { createTripHistoryHandler } from '../src/services/trip-history-handler.ts';

const handleGET = createTripHistoryHandler(findUserTripHistory, authenticate);

export const GET = withCors(handleGET);
export const OPTIONS = preflight;
