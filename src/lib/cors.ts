// Browser development origins. Native apps send no Origin header.
const allowedOrigins = new Set([
    'http://localhost:8081',
    'http://127.0.0.1:8081',
]);
const allowedMethods = new Set(['GET', 'POST']);
const allowedHeaders = new Set(['authorization', 'content-type', 'accept']);

function corsHeaders(request: Request): Headers {
    const headers = new Headers({
        'Cache-Control': 'no-store',
        Vary: 'Origin',
    });
    const origin = request.headers.get('Origin');
    if (origin && allowedOrigins.has(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    }
    return headers;
}

export function preflight(request: Request): Response {
    const origin = request.headers.get('Origin');
    const method = request.headers.get('Access-Control-Request-Method');
    const requestedHeaders = (
        request.headers.get('Access-Control-Request-Headers') ?? ''
    ).split(',').map(value => value.trim().toLowerCase()).filter(Boolean);

    const allowed = origin !== null && allowedOrigins.has(origin) &&
        method !== null && allowedMethods.has(method) &&
        requestedHeaders.every(header => allowedHeaders.has(header));

    return new Response(null, {
        status: allowed ? 204 : 403,
        headers: corsHeaders(request),
    });
}

type Handler = (request: Request) => Promise<Response> | Response;

export function withCors(handler: Handler): Handler {
    return async request => {
        if (request.method === 'OPTIONS') return preflight(request);
        const origin = request.headers.get('Origin');
        if (origin && !allowedOrigins.has(origin)) {
            return Response.json(
                { error: 'origin_not_allowed' },
                { status: 403, headers: corsHeaders(request) },
            );
        }

        const response = await handler(request);
        const headers = new Headers(response.headers);
        headers.append('Vary', 'Origin');
        headers.set('Cache-Control', 'no-store');
        if (origin) headers.set('Access-Control-Allow-Origin', origin);

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    };
}
