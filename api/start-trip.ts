import { authenticate } from '../src/lib/request-auth.ts';
import { userTripRepository } from '../src/repositories/user-trip-repository.ts';
import { createStartTripHandler } from '../src/services/start-trip.ts';

export const POST = createStartTripHandler(authenticate, userTripRepository);
