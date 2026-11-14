import { preflight, withCors } from '../src/lib/cors.ts';
// Receives one trip's samples. Validation, ownership and storage rules are
// documented in src/services/upload-trip-samples.ts.
import { authenticate } from '../src/lib/request-auth.ts';
import { userTripRepository } from '../src/repositories/user-trip-repository.ts';
import { createUploadTripSamplesHandler } from '../src/services/upload-trip-samples.ts';

const handlePOST = createUploadTripSamplesHandler(authenticate, userTripRepository);

export const POST = withCors(handlePOST);
export const OPTIONS = preflight;
