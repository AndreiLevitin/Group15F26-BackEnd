import { createUserClient } from '../lib/supabase.js';
import type { TripAccess } from '../types/auth.js';

export async function findUserScoreAverages(access: TripAccess): Promise<unknown> {
    const client = createUserClient(access.accessToken);

    // The database derives the owner from this user's verified session.
    // No caller-supplied user ID or calculation time is accepted.
    const { data, error } = await client.rpc('get_my_score_averages');

    if (error) throw new Error('Could not read stored score averages.');
    return data;
}
