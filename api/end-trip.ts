import { preflight, withCors } from '../src/lib/cors.ts';
import { createTripCompletionDependencies } from '../src/lib/trip-completion-dependencies.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { userTripRepository } from '../src/repositories/user-trip-repository.ts';
import { completeTrip } from '../src/services/complete-trip.ts';
import { createEndTripHandler } from '../src/services/end-trip.ts';

const handlePOST = createEndTripHandler(
    authenticate,
    userTripRepository,
    tripId => completeTrip(tripId, createTripCompletionDependencies()),
);

export const POST = withCors(handlePOST);
export const OPTIONS = preflight;
