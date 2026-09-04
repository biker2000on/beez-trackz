/**
 * Typed fetch wrapper for the Apiary Atlas Go API.
 *
 * All requests go to `/api/v1/...` on the same origin (Next.js rewrites proxy
 * them to the Go server), so session cookies flow automatically.
 */

const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  /** Raw response body, when the server returned JSON. */
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * The service worker returns 202 `{queued, offline, mutationId}` when a write
 * is stored for later replay. That body is not the created entity.
 */
export class OfflineQueuedError extends ApiError {
  readonly mutationId: string | undefined;

  constructor(body?: unknown) {
    const mutationId =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { mutationId?: unknown }).mutationId === "string"
        ? (body as { mutationId: string }).mutationId
        : undefined;
    super(202, "Saved offline — will sync when you reconnect", body);
    this.name = "OfflineQueuedError";
    this.mutationId = mutationId;
  }
}

function isOfflineQueuedBody(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { queued?: unknown }).queued === true
  );
}

type QueryParams = Record<
  string,
  string | number | boolean | null | undefined
>;

interface RequestOptions {
  params?: QueryParams;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** The API prefix every path in this module is relative to. */
export const API_PREFIX = API_BASE;

/**
 * WorkItem commands carry an absolute API path (`/api/v1/feedings/…/refill`,
 * design §4.2) because the server is the one that knows it. Accepting it here
 * means a caller executing a command never has to strip a prefix — and can
 * never strip the wrong one.
 */
function buildUrl(path: string, params?: QueryParams): string {
  const url = path.startsWith(`${API_BASE}/`)
    ? path
    : path.startsWith("/")
      ? `${API_BASE}${path}`
      : `${API_BASE}/${path}`;
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

// After a session expiry every call 401s with a generic toast while the user
// keeps filling forms whose submissions will be lost. Redirect to /login
// once instead. Auth endpoints are exempt — the login/status flows interpret
// their own 401s.
let redirectingToLogin = false;

function handleUnauthorized(path: string) {
  if (typeof window === "undefined" || redirectingToLogin) return;
  if (path.startsWith("/auth/") || path.startsWith("auth/")) return;
  if (window.location.pathname.startsWith("/login")) return;
  redirectingToLogin = true;
  window.location.assign("/login");
}

/**
 * Response metadata a caller may need in addition to the parsed body.
 *
 * Reading only `content-type` (as this module did) is what made the service
 * worker's `X-Beez-Cache: stale` marker unreachable from React: a cached
 * field response was indistinguishable from a live one, which is exactly the
 * distinction the WorkItem contract's `freshness` has to make (design
 * 2026-09-03 §4.5). `headers` is the real `Headers` object so no caller has
 * to guess which header names matter next.
 */
export interface ApiResponseMeta {
  status: number;
  headers: Headers;
  /**
   * `X-Beez-Cache`, lowercased — "stale" when the service worker served this
   * body from its data cache because the network did not answer in time
   * (`sw.js/route.ts:400`). Null on a live response.
   */
  cache: string | null;
  /**
   * The response `Date`, parsed. For a cached response this is when the
   * origin produced the body, which is the honest `cachedAt`.
   */
  date: Date | null;
}

/** A parsed body together with the metadata of the response it came from. */
export interface ApiResult<T> {
  data: T;
  meta: ApiResponseMeta;
}

function responseMeta(res: Response): ApiResponseMeta {
  const raw = res.headers.get("date");
  const parsed = raw ? new Date(raw) : null;
  return {
    status: res.status,
    headers: res.headers,
    cache: res.headers.get("x-beez-cache")?.toLowerCase() ?? null,
    date: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
  };
}

async function requestWithMeta<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const init: RequestInit = {
    method,
    credentials: "include",
    signal: options.signal,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(buildUrl(path, options.params), init);

  let data: unknown = null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    data = await res.json().catch(() => null);
  }

  if (res.status === 202 && isOfflineQueuedBody(data)) {
    throw new OfflineQueuedError(data);
  }

  if (!res.ok) {
    if (res.status === 401) handleUnauthorized(path);
    const message =
      (data as { error?: string } | null)?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }

  return { data: data as T, meta: responseMeta(res) };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const result = await requestWithMeta<T>(method, path, body, options);
  return result.data;
}

export const api = {
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>("GET", path, undefined, options);
  },
  /** GET, keeping the response metadata (freshness headers, status). */
  getWithMeta<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return requestWithMeta<T>("GET", path, undefined, options);
  },
  /**
   * Dispatch by method name. WorkItem commands carry their own method and
   * path (design §4.2), so the caller executes the *source* command rather
   * than a generic work-item mutation; a switch at every call site would be
   * one more place for the two to disagree.
   */
  send<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return request<T>(method.toUpperCase(), path, body, options);
  },
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("POST", path, body, options);
  },
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("PUT", path, body, options);
  },
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("PATCH", path, body, options);
  },
  // Some soft-delete endpoints accept an optional {reason} body.
  delete<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("DELETE", path, body, options);
  },
};

/**
 * Some endpoints reject a batch by returning per-line errors alongside the
 * summary message (the equipment physical count, for example) so the caller can
 * point at the offending row instead of failing the whole form silently.
 */
export interface ApiLineError {
  index: number;
  stockId?: string | null;
  typeId?: string | null;
  message: string;
}

/** Extract per-line errors from a failed request; [] when there are none. */
export function apiLineErrors(error: unknown): ApiLineError[] {
  if (!(error instanceof ApiError)) return [];
  const body = error.body as { errors?: unknown } | null;
  if (!body || !Array.isArray(body.errors)) return [];
  return body.errors.filter(
    (entry): entry is ApiLineError =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ApiLineError).index === "number" &&
      typeof (entry as ApiLineError).message === "string",
  );
}

/** Shape returned by GET /api/v1/auth/status. */
export interface AuthStatus {
  authenticated: boolean;
  setupComplete: boolean;
  oidcEnabled: boolean;
  passwordLogin: boolean;
  displayName?: string;
  /**
   * Present only once authenticated. /auth/status already carries the admin
   * flag, so role gating that needs nothing else can read it here instead of
   * making a second /access/me round trip (SEAM-019).
   */
  isAdmin?: boolean;
}
