import { proveSpeedLimitScoring } from '../lib/speed-limit-scoring-proof.ts';
import { readBearerToken, unauthorized } from '../services/request-auth.ts';

export async function POST(request: Request): Promise<Response> {
    if (!readBearerToken(request)) return unauthorized();

    try {
        const { authenticate } = await import('../lib/request-auth.ts');
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        const [{ supabase }, { readRecordedTripData }, { saveTripScore }] = await Promise.all([
            import('../lib/supabase.ts'),
            import('../repositories/recorded-trip-repository.ts'),
            import('../repositories/trip-score-repository.ts'),
        ]);
        const result = await proveSpeedLimitScoring(supabase, { readRecordedTripData, saveTripScore });
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        console.error('AB#110 speed limit scoring proof failed', error);
        return Response.json({ error: 'proof_failed' }, { status: 500 });
    }
}
