
import { supabase } from '../src/lib/supabase.js';

export async function GET() {
    try {
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
