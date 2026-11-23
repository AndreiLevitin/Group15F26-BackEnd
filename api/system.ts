// Serves /api/health and /api/supabase-health
// (see rewrites in vercel.json and src/lib/route-dispatch.ts).
import { dispatch } from '../src/lib/route-dispatch.ts';

function serviceHealth() {
    return Response.json({
        status: "ok",
        service: "RevolutionInsure Backend"
    });
}

async function supabaseHealth() {
    try {
        // Loaded lazily: src/lib/supabase.ts throws when its environment
        // variables are missing, and /api/health must keep answering then.
        const { supabase } = await import('../src/lib/supabase.ts');
        const { error } = await supabase.auth.admin.listUsers({
            page: 1,
            perPage: 1,
        });

        if (error) {
            console.error('Supabase connection failed:', error.message);

            return Response.json(
                { status: 'error', supabase: 'unavailable' },
                { status: 503 }
            );
        }

        return Response.json({
            status: 'ok',
            supabase: 'connected',
        });
    } catch (error) {
        console.error('Supabase connection failed:', error);

        return Response.json(
            { status: 'error', supabase: 'unavailable' },
            { status: 503 }
        );
    }
}

export const GET = dispatch({
    'health': { GET: serviceHealth },
    'supabase-health': { GET: supabaseHealth },
});
