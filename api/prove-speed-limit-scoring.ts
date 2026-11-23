import { proveSpeedLimitScoring } from '../src/lib/speed-limit-scoring-proof.ts';
import { readBearerToken, unauthorized } from '../src/services/request-auth.ts';

export async function POST(request: Request): Promise<Response> {
    if (!readBearerToken(request)) return unauthorized();

    try {
        const { authenticate } = await import('../src/lib/request-auth.ts');
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        const [{ supabase }, { readRecordedTripData }, { saveTripScore }] = await Promise.all([
            import('../src/lib/supabase.ts'),
            import('../src/repositories/recorded-trip-repository.ts'),
            import('../src/repositories/trip-score-repository.ts'),
        ]);
        const result = await proveSpeedLimitScoring(supabase, { readRecordedTripData, saveTripScore });
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        console.error('AB#110 speed limit scoring proof failed', error);
        return Response.json({ error: 'proof_failed' }, { status: 500 });
    }
}
