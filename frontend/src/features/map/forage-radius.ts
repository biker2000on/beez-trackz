import { KM_PER_MILE } from "@/lib/units";
import type { UnitsSystem } from "@/lib/units";

/**
 * The forage circle around the apiary pin. Bees work well past this, but a
 * 2-3 km ring is what the tile layer can actually explain: tree line, crop,
 * water. It is not a land-cover classifier.
 *
 * The same radius is the pin-search radius the Immich yard timeline reads,
 * so the bounds here match the CHECK in migration 00027 and the constants in
 * backend/internal/httpapi/routes_apiaries.go.
 */
export const FORAGE_RADIUS_DEFAULT_M = 2500;
export const FORAGE_RADIUS_MIN_M = 250;
export const FORAGE_RADIUS_MAX_M = 8000;
export const FORAGE_RADIUS_STEP_M = 250;

/** Common working radii, offered as one tap instead of a slider drag. */
export const FORAGE_RADIUS_PRESETS_M = [1000, 2000, 2500, 3000, 5000];

export function clampForageRadius(meters: number | null | undefined): number {
  if (meters == null || !Number.isFinite(meters)) return FORAGE_RADIUS_DEFAULT_M;
  return Math.min(
    FORAGE_RADIUS_MAX_M,
    Math.max(FORAGE_RADIUS_MIN_M, Math.round(meters)),
  );
}

/**
 * Radius in the operator's units. Canonical storage is meters; US shows
 * miles, because a beekeeper who thinks in feet still thinks in miles here.
 */
export function formatForageRadius(
  meters: number | null | undefined,
  units: UnitsSystem,
): string {
  if (meters == null || !Number.isFinite(meters)) return "";
  if (units === "us") {
    const miles = meters / 1000 / KM_PER_MILE;
    return `${Math.round(miles * 100) / 100} mi`;
  }
  const km = meters / 1000;
  return `${Math.round(km * 100) / 100} km`;
}
