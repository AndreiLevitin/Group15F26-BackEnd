import type { ConsentRepository } from '../repositories/consent-repository.js';
import type { Authenticate } from './request-auth.ts';

/** GET /api/consent: whether the signed-in account has consented, and when. */
export function createConsentStatusHandler(
    authenticate: Authenticate,
    consent: Pick<ConsentRepository, 'findConsent'>,
) {
    return async function GET(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        try {
            const consentedAt = await consent.findConsent(auth.access.userId);
            return Response.json(
                { consented: consentedAt !== null, consentedAt },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        } catch (error) {
            console.error('Failed to read consent:', error);
            return Response.json(
                { error: 'consent_unavailable' },
                { status: 503, headers: { 'Cache-Control': 'no-store' } },
            );
        }
    };
}

/** POST /api/consent: records the signed-in account's consent. */
export function createRecordConsentHandler(
    authenticate: Authenticate,
    consent: Pick<ConsentRepository, 'recordConsent'>,
) {
    return async function POST(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        try {
            const consentedAt = await consent.recordConsent(auth.access.userId);
            return Response.json(
                { consented: true, consentedAt },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        } catch (error) {
            console.error('Failed to record consent:', error);
            return Response.json(
                { error: 'consent_unavailable' },
                { status: 503, headers: { 'Cache-Control': 'no-store' } },
            );
        }
    };
}