import { preflight, withCors } from '../src/lib/cors.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { consentRepository } from '../src/repositories/consent-repository.ts';
import { userTripRepository } from '../src/repositories/user-trip-repository.ts';
import { createStartTripHandler } from '../src/services/start-trip.ts';

const handlePOST = createStartTripHandler(authenticate, userTripRepository, consentRepository);

export const POST = withCors(handlePOST);
export const OPTIONS = preflight;
