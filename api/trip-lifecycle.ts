// Serves /api/start-trip, /api/upload-trip-samples and /api/end-trip
// (see rewrites in vercel.json and src/lib/route-dispatch.ts).
// Validation, ownership and storage rules for samples are documented in
// src/services/upload-trip-samples.ts.
import { preflight, withCors } from '../src/lib/cors.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { dispatch } from '../src/lib/route-dispatch.ts';
import { createTripCompletionDependencies } from '../src/lib/trip-completion-dependencies.ts';
import { userTripRepository } from '../src/repositories/user-trip-repository.ts';
import { completeTrip } from '../src/services/complete-trip.ts';
import { createEndTripHandler } from '../src/services/end-trip.ts';
import { createStartTripHandler } from '../src/services/start-trip.ts';
import { createUploadTripSamplesHandler } from '../src/services/upload-trip-samples.ts';

const handler = dispatch({
    'start-trip': {
        POST: withCors(createStartTripHandler(authenticate, userTripRepository)),
        OPTIONS: preflight,
    },
    'upload-trip-samples': {
        POST: withCors(createUploadTripSamplesHandler(authenticate, userTripRepository)),
        OPTIONS: preflight,
    },
    'end-trip': {
        POST: withCors(createEndTripHandler(
            authenticate,
            userTripRepository,
            tripId => completeTrip(tripId, createTripCompletionDependencies()),
        )),
        OPTIONS: preflight,
    },
});

export const POST = handler;
export const OPTIONS = handler;
