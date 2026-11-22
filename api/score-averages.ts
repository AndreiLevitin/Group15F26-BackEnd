import { preflight, withCors } from '../src/lib/cors.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { findUserScoreAverages } from '../src/repositories/score-averages-repository.ts';
import { createScoreAveragesHandler } from '../src/services/score-averages-handler.ts';

const handleGET = createScoreAveragesHandler(findUserScoreAverages, authenticate);

export const GET = withCors(handleGET);
export const OPTIONS = preflight;
