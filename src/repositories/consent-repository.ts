// Consent records for signed-in accounts (AB#106, Story 105).
// The user_consent table is granted to the service role only
// (database/007_user_consent.sql): the app never touches it directly. The
// service verifies the caller's access token first and passes the user id
// derived from that token, so an account can only ever read or record its
// own consent.
import { supabase } from '../lib/supabase.js';

export interface ConsentRepository {
    /** The time consent was given, or null when the account has not consented. */
    findConsent(userId: string): Promise<string | null>;
    /**
     * Records consent for the account and returns when it was given.
     * Recording twice keeps the first time: a retry or a double tap is the
     * same consent, not a new one.
     */
    recordConsent(userId: string): Promise<string>;
}

const uniqueViolation = '23505';

export const consentRepository: ConsentRepository = {
    async findConsent(userId) {
        const { data, error } = await supabase
            .from('user_consent')
            .select('consented_at')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw new Error(`Could not read consent: ${error.message}`);
        const row = data as { consented_at: string } | null;
        return row ? row.consented_at : null;
    },

    async recordConsent(userId) {
        const { data, error } = await supabase
            .from('user_consent')
            .insert({ user_id: userId })
            .select('consented_at')
            .single();
        if (error) {
            if (error.code === uniqueViolation) {
                const existing = await consentRepository.findConsent(userId);
                if (existing) return existing;
            }
            throw new Error(`Could not record consent: ${error.message}`);
        }
        return (data as { consented_at: string }).consented_at;
    },
};
