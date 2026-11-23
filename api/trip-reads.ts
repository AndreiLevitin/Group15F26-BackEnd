// Serves /api/trip-result, /api/trip-history and /api/score-averages
// (see rewrites in vercel.json and src/lib/route-dispatch.ts).
import { preflight, withCors } from '../src/lib/cors.ts';
import { authenticate } from '../src/lib/request-auth.ts';
import { dispatch } from '../src/lib/route-dispatch.ts';
import { findUserScoreAverages } from '../src/repositories/score-averages-repository.ts';
import { findUserTripHistory } from '../src/repositories/trip-history-repository.ts';
import { findTripResult } from '../src/repositories/trip-result-repository.ts';
import { createScoreAveragesHandler } from '../src/services/score-averages-handler.ts';
import { createTripHistoryHandler } from '../src/services/trip-history-handler.ts';
import { createTripResultHandler } from '../src/services/trip-result.ts';

const handler = dispatch({
    'trip-result': {
        GET: withCors(createTripResultHandler(findTripResult, authenticate)),
        OPTIONS: preflight,
    },
    'trip-history': {
        GET: withCors(createTripHistoryHandler(findUserTripHistory, authenticate)),
        OPTIONS: preflight,
    },
    'score-averages': {
        GET: withCors(createScoreAveragesHandler(findUserScoreAverages, authenticate)),
        OPTIONS: preflight,
    },
});

export const GET = handler;
export const OPTIONS = handler;
