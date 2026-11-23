import { GET as health } from '../src/handlers/health.ts';
import { POST as proveSpeedLimitScoring } from '../src/handlers/prove-speed-limit-scoring.ts';

function route(request: Request): string | null {
    const url = new URL(request.url);
    return url.pathname === '/api/diagnostics'
        ? url.searchParams.get('check')
        : url.pathname.slice('/api/'.length);
}

export async function GET(request: Request): Promise<Response> {
    switch (route(request)) {
        case 'health':
            return health();
        case 'supabase-health': {
            const { GET: supabaseHealth } = await import('../src/handlers/supabase-health.ts');
            return supabaseHealth();
        }
        case 'prove-speed-limit-scoring':
            return new Response(null, { status: 405, headers: { Allow: 'POST' } });
        default:
            return new Response(null, { status: 404 });
    }
}

export function POST(request: Request): Promise<Response> | Response {
    switch (route(request)) {
        case 'prove-speed-limit-scoring':
            return proveSpeedLimitScoring(request);
        case 'health':
        case 'supabase-health':
            return new Response(null, { status: 405, headers: { Allow: 'GET' } });
        default:
            return new Response(null, { status: 404 });
    }
}
