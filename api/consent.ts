import { preflight, withCors } from '../src/lib/cors.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { consentRepository } from '../src/repositories/consent-repository.ts';
import {
    createConsentStatusHandler,
    createRecordConsentHandler,
} from '../src/services/consent-handler.ts';

const handleGET = createConsentStatusHandler(authenticate, consentRepository);
const handlePOST = createRecordConsentHandler(authenticate, consentRepository);

export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
export const OPTIONS = preflight;