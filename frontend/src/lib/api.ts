/**
 * Typed fetch wrapper for the Beez Trackz Go API.
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

type QueryParams = Record<
  string,
  string | number | boolean | null | undefined
>;

interface RequestOptions {
  params?: QueryParams;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function buildUrl(path: string, params?: QueryParams): string {
  const url = path.startsWith("/") ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
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

  if (!res.ok) {
    const message =
      (data as { error?: string } | null)?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }

  return data as T;
}

export const api = {
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>("GET", path, undefined, options);
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
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>("DELETE", path, undefined, options);
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
}
