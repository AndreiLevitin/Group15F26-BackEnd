import { createTripCompletionDependencies } from '../src/lib/trip-completion-dependencies.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { userTripRepository } from '../src/repositories/user-trip-repository.ts';
import { completeTrip } from '../src/services/complete-trip.ts';
import { createEndTripHandler } from '../src/services/end-trip.ts';

export const POST = createEndTripHandler(
    authenticate,
    userTripRepository,
    tripId => completeTrip(tripId, createTripCompletionDependencies()),
);
