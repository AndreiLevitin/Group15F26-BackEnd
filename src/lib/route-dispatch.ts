// Lets one Vercel function serve several public routes. The Hobby plan caps a
// deployment at 12 functions and every file in api/ is one, so related routes
// share a file. vercel.json rewrites each public URL to its group file with
// `?route=<name>`, so client-facing URLs stay unchanged.

type Handler = (request: Request) => Promise<Response> | Response;
type MethodHandlers = Partial<Record<string, Handler>>;
export type RouteTable = Record<string, MethodHandlers>;

function routeName(request: Request, routes: RouteTable): string | null {
    const url = new URL(request.url);
    // The original path wins when the platform preserves it; otherwise use the
    // route name the rewrite added.
    const lastSegment = url.pathname.split('/').filter(Boolean).pop();
    if (lastSegment && Object.hasOwn(routes, lastSegment)) return lastSegment;
    const fromQuery = url.searchParams.get('route');
    if (fromQuery && Object.hasOwn(routes, fromQuery)) return fromQuery;
    return null;
}

export function dispatch(routes: RouteTable): Handler {
    return request => {
        const name = routeName(request, routes);
        if (name === null) {
            return Response.json({ error: 'not_found' }, { status: 404 });
        }

        const methods = routes[name] ?? {};
        const handler = methods[request.method];
        if (!handler) {
            return Response.json(
                { error: 'method_not_allowed' },
                { status: 405, headers: { Allow: Object.keys(methods).join(', ') } },
            );
        }
        return handler(request);
    };
}
