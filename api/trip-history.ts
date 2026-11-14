import { authenticate } from '../src/lib/request-auth.ts';
import { findUserTripHistory } from '../src/repositories/trip-history-repository.js';
import { createTripHistoryHandler } from '../src/services/trip-history-handler.ts';

export const GET = createTripHistoryHandler(findUserTripHistory, authenticate);
