const DEFAULT_ROUTES = Object.freeze({
    ROUTE_GTM: "tg",
    ROUTE_GA: "an",
    ROUTE_UMAMI_SCRIPT: "stats",
    ROUTE_UMAMI_API: "api",
    ROUTE_CLARITY: "cla",
    ROUTE_PH_JS: "phj",
    ROUTE_PH_API: "pha",
});

const JS_CONTENT_TYPES = [
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
];

function toBoolean(value, fallback) {
    if (typeof value !== "string") {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (
        normalized === "1" ||
        normalized === "true" ||
        normalized === "yes" ||
        normalized === "on"
    ) {
        return true;
    }

    if (
        normalized === "0" ||
        normalized === "false" ||
        normalized === "no" ||
        normalized === "off"
    ) {
        return false;
    }

    return fallback;
}

function cleanRoute(value, fallback) {
    const raw = typeof value === "string" ? value.trim() : "";
    const normalized = raw.replace(/^\/+|\/+$/g, "");
    return normalized || fallback;
}

function resolveRoutes(env) {
    return {
        ROUTE_GTM: cleanRoute(env.ROUTE_GTM, DEFAULT_ROUTES.ROUTE_GTM),
        ROUTE_GA: cleanRoute(env.ROUTE_GA, DEFAULT_ROUTES.ROUTE_GA),
        ROUTE_UMAMI_SCRIPT: cleanRoute(
            env.ROUTE_UMAMI_SCRIPT,
            DEFAULT_ROUTES.ROUTE_UMAMI_SCRIPT
        ),
        ROUTE_UMAMI_API: cleanRoute(
            env.ROUTE_UMAMI_API,
            DEFAULT_ROUTES.ROUTE_UMAMI_API
        ),
        ROUTE_CLARITY: cleanRoute(
            env.ROUTE_CLARITY,
            DEFAULT_ROUTES.ROUTE_CLARITY
        ),
        ROUTE_PH_JS: cleanRoute(env.ROUTE_PH_JS, DEFAULT_ROUTES.ROUTE_PH_JS),
        ROUTE_PH_API: cleanRoute(
            env.ROUTE_PH_API,
            DEFAULT_ROUTES.ROUTE_PH_API
        ),
    };
}

function resolveFeatureFlags(env) {
    return {
        clarityProxyCollect: toBoolean(env.CLARITY_PROXY_COLLECT, true),
    };
}

function matchPrefixedPath(pathname, routeValue) {
    const prefix = `/${routeValue}`;
    if (!pathname.startsWith(`${prefix}/`)) {
        return null;
    }

    const remaining = pathname.slice(prefix.length);
    return remaining.length > 0 ? remaining : "/";
}

function shouldRewriteResponse(headers) {
    const contentType = (headers.get("content-type") || "").toLowerCase();
    return JS_CONTENT_TYPES.some((value) => contentType.includes(value));
}

function rewriteBody(text, replacements, regexReplacements) {
    let rewritten = text;
    for (const [fromValue, toValue] of replacements) {
        rewritten = rewritten.split(fromValue).join(toValue);
    }

    if (regexReplacements) {
        for (const [pattern, replacement] of regexReplacements) {
            rewritten = rewritten.replace(pattern, replacement);
        }
    }

    return rewritten;
}

function applyRequestHeaderOverrides(headers, overrides) {
    if (!overrides) {
        return;
    }

    for (const [name, value] of Object.entries(overrides)) {
        headers.set(name, value);
    }
}

function getClientIp(request) {
    const cfConnectingIp = request.headers.get("cf-connecting-ip");
    if (cfConnectingIp) {
        return cfConnectingIp;
    }

    const forwardedFor = request.headers.get("x-forwarded-for");
    if (forwardedFor) {
        return forwardedFor.split(",")[0].trim();
    }

    return "0.0.0.0";
}

function buildProxyHeaders(request, upstreamHost, clientIp, requestUrl) {
    const headers = new Headers(request.headers);

    headers.set("host", upstreamHost);
    headers.delete("accept-encoding");
    headers.delete("connection");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.set("x-real-ip", clientIp);

    const priorForwardedFor = request.headers.get("x-forwarded-for");
    headers.set(
        "x-forwarded-for",
        priorForwardedFor ? `${priorForwardedFor}, ${clientIp}` : clientIp
    );
    headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));
    headers.set("referer", "");

    return headers;
}

function normalizeUpstreamPath(pathname) {
    if (!pathname || pathname.length === 0) {
        return "/";
    }

    if (pathname.startsWith("/")) {
        return pathname;
    }

    return `/${pathname}`;
}

function getUmamiCorsHeaders() {
    return {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, User-Agent, X-Umami-Hostname, X-Umami-Website-Id",
    };
}

function createMethodNotAllowed(allowValue) {
    return new Response("Method Not Allowed", {
        status: 405,
        headers: {
            allow: allowValue,
            "content-type": "text/plain; charset=utf-8",
        },
    });
}

function getServices(routes, host, features) {
    const mapUmamiApiPath = (path) => {
        if (path === "/collect" || path === "/send") {
            return "/api/send";
        }

        return `/api${path}`;
    };

    const resolveClarityUpstreamOrigin = (path) => {
        const subdomainCollectMatch = path.match(/^\/([a-z0-9-]+)\/collect$/i);
        if (subdomainCollectMatch) {
            return `https://${subdomainCollectMatch[1].toLowerCase()}.clarity.ms`;
        }

        if (path === "/collect") {
            return "https://q.clarity.ms";
        }

        if (path.startsWith("/tag/")) {
            return "https://www.clarity.ms";
        }

        return "https://scripts.clarity.ms";
    };

    const mapClarityPath = (path) => {
        const subdomainCollectMatch = path.match(/^\/([a-z0-9-]+)\/collect$/i);
        if (subdomainCollectMatch) {
            return "/collect";
        }

        return path;
    };

    const getClarityRequestHeaderOverrides = (_clientIp, path) => {
        const isCollectPath =
            path === "/collect" || /^\/([a-z0-9-]+)\/collect$/i.test(path);

        if (!isCollectPath) {
            return null;
        }

        return {
            accept: "application/x-clarity-gzip",
            "content-type": "application/octet-stream",
        };
    };

    const clarityRouteBase = `${host}/${routes.ROUTE_CLARITY}`;
    const clarityReplacements = [];

    if (features.clarityProxyCollect) {
        clarityReplacements.push(
            ["www.clarity.ms", clarityRouteBase],
            ["scripts.clarity.ms", clarityRouteBase],
            ["q.clarity.ms", `${clarityRouteBase}/q`],
            ["k.clarity.ms", `${clarityRouteBase}/k`],
            ["m.clarity.ms", `${clarityRouteBase}/m`]
        );
    }

    const clarityRegexReplacements = [];
    if (features.clarityProxyCollect) {
        clarityRegexReplacements.push([
            /([a-z0-9-]+\.)?clarity\.ms/gi,
            clarityRouteBase,
        ]);
    } else {
        clarityRegexReplacements.push(
            [
                /https:\/\/www\.clarity\.ms\/tag\//gi,
                `https://${clarityRouteBase}/tag/`,
            ],
            [
                /https:\/\/scripts\.clarity\.ms\//gi,
                `https://${clarityRouteBase}/`,
            ],
            [/\/\/www\.clarity\.ms\/tag\//gi, `//${clarityRouteBase}/tag/`],
            [/\/\/scripts\.clarity\.ms\//gi, `//${clarityRouteBase}/`]
        );
    }

    clarityRegexReplacements.push([/"track"\s*:\s*false/gi, '"track":true']);

    return [
        {
            route: routes.ROUTE_GTM,
            upstreamOrigin: "https://www.googletagmanager.com",
            mapPath: (path) => (path === "/script.js" ? "/gtag/js" : path),
            replacements: [
                ["www.googletagmanager.com", `${host}/${routes.ROUTE_GTM}`],
                ["www.google-analytics.com", `${host}/${routes.ROUTE_GA}`],
                ["/gtag/js", "/script.js"],
                ["/g/collect", "/g/e"],
            ],
        },
        {
            route: routes.ROUTE_GA,
            upstreamOrigin: "https://www.google-analytics.com",
            mapPath: (path) => path,
            replacements: [
                ["www.google-analytics.com", `${host}/${routes.ROUTE_GA}`],
                ["/g/collect", "/g/e"],
            ],
        },
        {
            route: routes.ROUTE_UMAMI_SCRIPT,
            upstreamOrigin: "https://cloud.umami.is",
            mapPath: (path) => path,
            replacements: [],
        },
        {
            route: routes.ROUTE_UMAMI_API,
            upstreamOrigin: "https://cloud.umami.is",
            mapPath: mapUmamiApiPath,
            replacements: [],
            requestHeaderOverrides: (clientIp) => ({
                "x-forwarded-for": clientIp,
                "x-real-ip": clientIp,
                "cf-connecting-ip": clientIp,
            }),
        },
        {
            route: routes.ROUTE_CLARITY,
            upstreamOrigin: "https://www.clarity.ms",
            resolveUpstreamOrigin: resolveClarityUpstreamOrigin,
            mapPath: mapClarityPath,
            replacements: clarityReplacements,
            regexReplacements: clarityRegexReplacements,
            requestHeaderOverrides: getClarityRequestHeaderOverrides,
        },
        {
            route: routes.ROUTE_PH_JS,
            upstreamOrigin: "https://us-assets.i.posthog.com",
            mapPath: (path) => path,
            replacements: [
                ["us-assets.i.posthog.com", `${host}/${routes.ROUTE_PH_JS}`],
            ],
        },
        {
            route: routes.ROUTE_PH_API,
            upstreamOrigin: "https://us.i.posthog.com",
            mapPath: (path) => path,
            replacements: [],
        },
    ];
}

async function proxyRequest({
    request,
    requestUrl,
    upstreamOrigin,
    upstreamPath,
    query,
    clientIp,
    replacements,
    requestHeaderOverrides,
    regexReplacements,
}) {
    const upstreamUrl = new URL(upstreamOrigin);
    upstreamUrl.pathname = normalizeUpstreamPath(upstreamPath);

    if (typeof query === "string") {
        upstreamUrl.search = query.length > 0 ? `?${query}` : "";
    } else {
        upstreamUrl.search = requestUrl.search;
    }

    const method = request.method.toUpperCase();
    const headers = buildProxyHeaders(
        request,
        upstreamUrl.host,
        clientIp,
        requestUrl
    );
    applyRequestHeaderOverrides(headers, requestHeaderOverrides);

    const init = {
        method,
        headers,
        redirect: "manual",
    };

    if (method !== "GET" && method !== "HEAD") {
        init.body = request.body;
    }

    let upstreamResponse;
    try {
        upstreamResponse = await fetch(upstreamUrl.toString(), init);
    } catch {
        return new Response("Upstream request failed", {
            status: 502,
            headers: {
                "content-type": "text/plain; charset=utf-8",
            },
        });
    }

    const hasTextRewrites =
        replacements.length > 0 ||
        (Array.isArray(regexReplacements) && regexReplacements.length > 0);

    if (
        hasTextRewrites &&
        shouldRewriteResponse(upstreamResponse.headers)
    ) {
        const sourceText = await upstreamResponse.text();
        const rewrittenText = rewriteBody(
            sourceText,
            replacements,
            regexReplacements
        );

        const rewrittenHeaders = new Headers(upstreamResponse.headers);
        rewrittenHeaders.delete("content-length");

        return new Response(rewrittenText, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: rewrittenHeaders,
        });
    }

    return upstreamResponse;
}

export default {
    async fetch(request, env) {
        const requestUrl = new URL(request.url);
        const pathname = requestUrl.pathname;
        const method = request.method.toUpperCase();

        if (pathname === "/health") {
            return new Response("OK", {
                status: 200,
                headers: {
                    "content-type": "text/plain; charset=utf-8",
                },
            });
        }

        const routes = resolveRoutes(env || {});
        const features = resolveFeatureFlags(env || {});
        const clientIp = getClientIp(request);
        const host = request.headers.get("host") || requestUrl.host;
        const umamiCollectPath = `/${routes.ROUTE_UMAMI_API}/collect`;
        const umamiSendPath = `/${routes.ROUTE_UMAMI_API}/send`;
        const clarityBasePath = `/${routes.ROUTE_CLARITY}`;

        if (!features.clarityProxyCollect) {
            const claritySubdomainCollectMatch = pathname.match(
                new RegExp(`^${clarityBasePath}/([a-z0-9-]+)/collect$`, "i")
            );

            if (claritySubdomainCollectMatch) {
                const directCollectUrl = new URL(
                    `https://${claritySubdomainCollectMatch[1].toLowerCase()}.clarity.ms/collect`
                );
                directCollectUrl.search = requestUrl.search;
                return Response.redirect(directCollectUrl.toString(), 307);
            }

            if (pathname === `${clarityBasePath}/collect`) {
                const directCollectUrl = new URL("https://q.clarity.ms/collect");
                directCollectUrl.search = requestUrl.search;
                return Response.redirect(directCollectUrl.toString(), 307);
            }
        }

        if (pathname === umamiCollectPath || pathname === umamiSendPath) {
            if (method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: getUmamiCorsHeaders(),
                });
            }

            if (method !== "POST") {
                return createMethodNotAllowed("POST, OPTIONS");
            }
        }

        if (pathname === `/${routes.ROUTE_GA}/g/e`) {
            const query = new URLSearchParams(requestUrl.search);
            query.append("_uip", clientIp);

            return proxyRequest({
                request,
                requestUrl,
                upstreamOrigin: "https://www.google-analytics.com",
                upstreamPath: "/g/collect",
                query: query.toString(),
                clientIp,
                replacements: [],
            });
        }

        const services = getServices(routes, host, features);
        for (const service of services) {
            const remainingPath = matchPrefixedPath(pathname, service.route);
            if (remainingPath === null) {
                continue;
            }

            const resolvedUpstreamOrigin = service.resolveUpstreamOrigin
                ? service.resolveUpstreamOrigin(remainingPath)
                : service.upstreamOrigin;

            return proxyRequest({
                request,
                requestUrl,
                upstreamOrigin: resolvedUpstreamOrigin,
                upstreamPath: service.mapPath(remainingPath),
                clientIp,
                replacements: service.replacements,
                requestHeaderOverrides: service.requestHeaderOverrides
                    ? service.requestHeaderOverrides(clientIp, remainingPath)
                    : null,
                regexReplacements: service.regexReplacements || null,
            });
        }

        return new Response("Not Found", {
            status: 404,
            headers: {
                "content-type": "text/plain; charset=utf-8",
            },
        });
    },
};
