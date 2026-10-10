import { ApiError } from "@/lib/api";

/** Turns a snake_case kind or category into a readable label. */
export function humanize(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * What actually went wrong with a failed read, for an error state that has to
 * be actionable: the HTTP status and the server's own message when there was
 * a response, or the transport error when there was none.
 */
export function describeRequestError(error: unknown): string {
  if (error instanceof ApiError) {
    const generic = `Request failed (${error.status})`;
    const detail =
      error.message && error.message !== generic ? ` — ${error.message}` : "";
    return `HTTP ${error.status}${detail}`;
  }
  if (error instanceof Error && error.message) {
    return `No response from the server — ${error.message}`;
  }
  return "No response from the server";
}

/**
 * True when Folio sync has never been set up: no server URL or no API token.
 * Distinct from "configured but disabled", where the connection exists and
 * pushes are merely paused.
 */
export function isFolioConfigured(settings: {
  baseUrl: string;
  hasToken: boolean;
}): boolean {
  return settings.baseUrl.trim() !== "" && settings.hasToken;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
