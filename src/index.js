const DEFAULT_ROUTES = Object.freeze({
    ROUTE_GTM: "tggg",
    ROUTE_GA: "angg",
    ROUTE_UMAMI_SCRIPT: "statsgg",
    ROUTE_UMAMI_API: "api",
});

const JS_CONTENT_TYPES = [
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
];

// Every GA4 collect host gets its own path under /<ROUTE_GA>/g/e so the
// rewritten gtag.js can send all hits through this Worker.
const GA_COLLECT_TARGETS = [
    { suffix: "", host: "www.google-analytics.com" },
    { suffix: "/region1", host: "region1.google-analytics.com" },
    { suffix: "/ag", host: "analytics.google.com" },
    { suffix: "/region1-ag", host: "region1.analytics.google.com" },
    { suffix: "/dc", host: "stats.g.doubleclick.net" },
];

// Path and method allowlists. If a feature breaks, check the Network tab for
// 404s from this Worker and add the missing path here.
const GA_COLLECT_METHODS = ["GET", "POST", "OPTIONS"];
const GTM_ALLOWED_PATHS = ["/script.js", "/gtm.js", "/gtag/destination"];
const UMAMI_SCRIPT_PATHS = ["/script.js"];
const UMAMI_API_PATHS = ["/collect", "/send"];

const UMAMI_PREFLIGHT_MAX_AGE = "86400";
const UMAMI_MAX_BODY_BYTES = 32768;


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
    };
}

function parseList(value) {
    if (typeof value !== "string") {
        return [];
    }

    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

// Optional Worker vars (both are skipped when unset):
//   ALLOWED_ORIGINS  e.g. "example.com,www.example.com,*.example.com"
//   ALLOWED_GA_IDS   e.g. "G-ABC123XYZ,GTM-ABCD123"
function resolveAccessRules(env) {
    return {
        allowedHosts: parseList(env.ALLOWED_ORIGINS).map((item) =>
            item.toLowerCase()
        ),
        allowedIds: parseList(env.ALLOWED_GA_IDS).map((item) =>
            item.toUpperCase()
        ),
    };
}

function hostMatches(hostname, patterns) {
    const value = hostname.toLowerCase();
    return patterns.some((pattern) => {
        if (pattern.startsWith("*.")) {
            return value.endsWith(pattern.slice(1));
        }

        return value === pattern;
    });
}

// Rejects a request only when it carries an Origin/Referer that is not on the
// list. Requests with neither header pass, because privacy settings strip
// them. This deters casual abuse only; the path and ID allowlists do the
// real limiting.
function isAllowedOrigin(request, allowedHosts) {
    if (allowedHosts.length === 0) {
        return true;
    }

    const source =
        request.headers.get("origin") || request.headers.get("referer");
    if (!source) {
        return true;
    }

    try {
        return hostMatches(new URL(source).hostname, allowedHosts);
    } catch {
        return false;
    }
}

function isAllowedId(id, allowedIds) {
    if (allowedIds.length === 0) {
        return true;
    }

    return typeof id === "string" && allowedIds.includes(id.toUpperCase());
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const headers = new Headers();
    const allowedRequestHeaders = [
        "accept",
        "accept-language",
        "content-type",
        "origin",
        "user-agent",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
        "x-umami-cache",
    ];

    for (const name of allowedRequestHeaders) {
        const value = request.headers.get(name);
        if (value) {
            headers.set(name, value);
        }
    }

    headers.set("host", upstreamHost);
    headers.set("x-real-ip", clientIp);
    headers.set("x-forwarded-for", clientIp);
    headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));

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
        "access-control-allow-headers": "Content-Type, User-Agent, X-Umami-Cache, X-Umami-Hostname, X-Umami-Website-Id",
    };
}

function getUmamiPreflightHeaders() {
    return {
        ...getUmamiCorsHeaders(),
        "access-control-max-age": UMAMI_PREFLIGHT_MAX_AGE,
    };
}

// On a Worker subrequest Umami sees this Worker's side of the connection, so
// its IP and Cloudflare geo headers describe the Worker, not the visitor. The
// payload "ip" override makes Umami use the real IP and look the location up
// from it instead.
async function buildUmamiBody(request, clientIp) {
    const fail = (status, text) =>
        addResponseHeaders(createPlainResponse(status, text), getUmamiCorsHeaders());

    const text = await request.text();
    if (text.length > UMAMI_MAX_BODY_BYTES) {
        return { error: fail(413, "Payload Too Large") };
    }

    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return { error: fail(400, "Bad Request") };
    }

    if (!body || typeof body.payload !== "object" || body.payload === null) {
        return { error: fail(400, "Bad Request") };
    }

    body.payload.ip = clientIp;
    return { body: JSON.stringify(body) };
}

function addResponseHeaders(response, additions) {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(additions)) {
        headers.set(name, value);
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function createPlainResponse(status, text) {
    return new Response(text, {
        status,
        headers: {
            "content-type": "text/plain; charset=utf-8",
        },
    });
}

function createBadGateway(responseHeaderOverrides) {
    const response = createPlainResponse(502, "Upstream request failed");
    return responseHeaderOverrides
        ? addResponseHeaders(response, responseHeaderOverrides)
        : response;
}

function createMethodNotAllowed(allowValue, additionalHeaders = {}) {
    return new Response("Method Not Allowed", {
        status: 405,
        headers: {
            allow: allowValue,
            "content-type": "text/plain; charset=utf-8",
            ...additionalHeaders,
        },
    });
}

function getServices(routes, host) {
    const mapUmamiApiPath = (path) => {
        if (path === "/collect" || path === "/send") {
            return "/api/send";
        }

        return `/api${path}`;
    };

    // Rewrites every GA4 collect URL inside gtag.js (absolute or
    // protocol-relative) to the matching /<ROUTE_GA>/g/e path on this host.
    const gaRegexReplacements = GA_COLLECT_TARGETS.map((target) => [
        new RegExp(
            `(https:)?\\/\\/${escapeRegex(target.host)}\\/g\\/collect`,
            "gi"
        ),
        `$1//${host}/${routes.ROUTE_GA}/g/e${target.suffix}`,
    ]);

    // GA hits are handled by the dedicated /g/collect and /g/e branch in
    // fetch(), so there is no generic pass-through service for ROUTE_GA.
    return [
        {
            route: routes.ROUTE_GTM,
            upstreamOrigin: "https://www.googletagmanager.com",
            allowedPaths: GTM_ALLOWED_PATHS,
            allowedMethods: ["GET", "HEAD"],
            idParam: "id",
            mapPath: (path) => (path === "/script.js" ? "/gtag/js" : path),
            replacements: [
                ["www.googletagmanager.com", `${host}/${routes.ROUTE_GTM}`],
                ["/gtag/js", "/script.js"],
            ],
            regexReplacements: gaRegexReplacements,
        },
        {
            route: routes.ROUTE_UMAMI_SCRIPT,
            upstreamOrigin: "https://cloud.umami.is",
            allowedPaths: UMAMI_SCRIPT_PATHS,
            allowedMethods: ["GET", "HEAD"],
            mapPath: (path) => path,
            replacements: [
                [
                    "https://gateway.umami.is",
                    `https://${host}/${routes.ROUTE_UMAMI_API}`,
                ],
            ],
        },
        {
            route: routes.ROUTE_UMAMI_API,
            upstreamOrigin: "https://cloud.umami.is",
            allowedPaths: UMAMI_API_PATHS,
            allowedMethods: ["POST"],
            injectClientIp: true,
            mapPath: mapUmamiApiPath,
            replacements: [],
            requestHeaderOverrides: (clientIp) => ({
                "x-forwarded-for": clientIp,
                "x-real-ip": clientIp,
                "cf-connecting-ip": clientIp,
            }),
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
    responseHeaderOverrides,
    regexReplacements,
    bodyOverride,
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

    // GET/HEAD redirects are followed here so the browser never sees an
    // upstream Location. Requests with a body can't be replayed safely, so a
    // redirect on those is treated as a failure below.
    const canFollowRedirects = method === "GET" || method === "HEAD";

    const init = {
        method,
        headers,
        redirect: canFollowRedirects ? "follow" : "manual",
    };

    if (method !== "GET" && method !== "HEAD") {
        init.body = bodyOverride !== undefined ? bodyOverride : request.body;
    }

    let upstreamResponse;
    try {
        upstreamResponse = await fetch(upstreamUrl.toString(), init);
    } catch {
        return createBadGateway(responseHeaderOverrides);
    }

    if (
        !canFollowRedirects &&
        upstreamResponse.status >= 300 &&
        upstreamResponse.status < 400
    ) {
        return createBadGateway(responseHeaderOverrides);
    }

    const hasTextRewrites =
        replacements.length > 0 ||
        (Array.isArray(regexReplacements) && regexReplacements.length > 0);
    const canHaveResponseBody =
        method !== "HEAD" &&
        upstreamResponse.status !== 204 &&
        upstreamResponse.status !== 205 &&
        upstreamResponse.status !== 304;

    if (
        canHaveResponseBody &&
        hasTextRewrites &&
        shouldRewriteResponse(upstreamResponse.headers)
    ) {
        let sourceText;
        try {
            sourceText = await upstreamResponse.text();
        } catch {
            return createBadGateway(responseHeaderOverrides);
        }

        const rewrittenText = rewriteBody(
            sourceText,
            replacements,
            regexReplacements
        );

        const rewrittenHeaders = new Headers(upstreamResponse.headers);
        rewrittenHeaders.delete("content-length");
        rewrittenHeaders.delete("content-md5");
        rewrittenHeaders.delete("digest");
        rewrittenHeaders.delete("etag");
        rewrittenHeaders.delete("set-cookie");

        const response = new Response(rewrittenText, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: rewrittenHeaders,
        });

        return responseHeaderOverrides
            ? addResponseHeaders(response, responseHeaderOverrides)
            : response;
    }

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete("set-cookie");
    const response = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
    });

    return responseHeaderOverrides
        ? addResponseHeaders(response, responseHeaderOverrides)
        : response;
}

export default {
    async fetch(request, env) {
        const requestUrl = new URL(request.url);
        const pathname = requestUrl.pathname;
        const method = request.method.toUpperCase();

        if (pathname === "/health") {
            return createPlainResponse(200, "OK");
        }

        const safeEnv = env || {};
        const routes = resolveRoutes(safeEnv);
        const { allowedHosts, allowedIds } = resolveAccessRules(safeEnv);

        if (!isAllowedOrigin(request, allowedHosts)) {
            return createPlainResponse(403, "Forbidden");
        }

        const clientIp = getClientIp(request);
        const host = request.headers.get("host") || requestUrl.host;
        const umamiCollectPath = `/${routes.ROUTE_UMAMI_API}/collect`;
        const umamiSendPath = `/${routes.ROUTE_UMAMI_API}/send`;

        if (pathname === umamiCollectPath || pathname === umamiSendPath) {
            if (method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: getUmamiPreflightHeaders(),
                });
            }

            if (method !== "POST") {
                return createMethodNotAllowed("POST, OPTIONS", getUmamiCorsHeaders());
            }
        }

        const gaCollectBase = `/${routes.ROUTE_GA}/g/e`;
        // /g/collect is what gtag.js sends to when transport_url points at
        // /<ROUTE_GA>; /g/e/... is what the rewritten gtag.js URLs use.
        const gaTarget =
            pathname === `/${routes.ROUTE_GA}/g/collect`
                ? GA_COLLECT_TARGETS[0]
                : GA_COLLECT_TARGETS.find(
                      (target) => pathname === `${gaCollectBase}${target.suffix}`
                  );
        if (gaTarget) {
            if (!GA_COLLECT_METHODS.includes(method)) {
                return createMethodNotAllowed(GA_COLLECT_METHODS.join(", "));
            }

            const query = new URLSearchParams(requestUrl.search);
            if (!isAllowedId(query.get("tid"), allowedIds)) {
                return createPlainResponse(403, "Forbidden");
            }

            query.set("_uip", clientIp);

            return proxyRequest({
                request,
                requestUrl,
                upstreamOrigin: `https://${gaTarget.host}`,
                upstreamPath: "/g/collect",
                query: query.toString(),
                clientIp,
                replacements: [],
            });
        }

        const services = getServices(routes, host);
        for (const service of services) {
            const remainingPath = matchPrefixedPath(pathname, service.route);
            if (remainingPath === null) {
                continue;
            }

            if (!service.allowedPaths.includes(remainingPath)) {
                return createPlainResponse(404, "Not Found");
            }

            if (!service.allowedMethods.includes(method)) {
                return createMethodNotAllowed(service.allowedMethods.join(", "));
            }

            if (
                service.idParam &&
                !isAllowedId(requestUrl.searchParams.get(service.idParam), allowedIds)
            ) {
                return createPlainResponse(403, "Forbidden");
            }

            let bodyOverride;
            if (service.injectClientIp) {
                const result = await buildUmamiBody(request, clientIp);
                if (result.error) {
                    return result.error;
                }

                bodyOverride = result.body;
            }

            const resolvedUpstreamOrigin = service.resolveUpstreamOrigin
                ? service.resolveUpstreamOrigin(remainingPath)
                : service.upstreamOrigin;

            return proxyRequest({
                request,
                requestUrl,
                upstreamOrigin: resolvedUpstreamOrigin,
                bodyOverride,
                upstreamPath: service.mapPath(remainingPath),
                clientIp,
                replacements: service.replacements,
                requestHeaderOverrides: service.requestHeaderOverrides
                    ? service.requestHeaderOverrides(clientIp, remainingPath)
                    : null,
                responseHeaderOverrides:
                    service.route === routes.ROUTE_UMAMI_API &&
                    (remainingPath === "/collect" || remainingPath === "/send")
                        ? getUmamiCorsHeaders()
                        : null,
                regexReplacements: service.regexReplacements || null,
            });
        }

        return createPlainResponse(404, "Not Found");
    },
};