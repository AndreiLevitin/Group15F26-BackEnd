
import { preflight, withCors } from '../src/lib/cors.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { profileRepository } from '../src/repositories/profile-repository.ts';
import {
    createProfileReadHandler,
    createProfileSaveHandler,
} from '../src/services/profile-handler.ts';

const handleGET = createProfileReadHandler(authenticate, profileRepository);
const handlePOST = createProfileSaveHandler(authenticate, profileRepository);

export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
export const OPTIONS = preflight;