
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error('Supabase environment variables are missing');
}

const url: string = supabaseUrl;
const secretKey: string = supabaseSecretKey;

function createServerClient() {
    return createClient(url, secretKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}

export const supabase = createServerClient();

// Signing a user in stores their session on the client that made the call,
// and later database queries on that client would run as that user instead
// of with the secret key. Each sign-in therefore gets its own short-lived
// client so the shared `supabase` client above is never affected.
export function createSignInClient() {
    return createServerClient();
}
