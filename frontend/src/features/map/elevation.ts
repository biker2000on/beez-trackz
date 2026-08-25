export type ElevationSource = "geolocation" | "terrain" | "override";

export const ELEVATION_SOURCE_LABEL: Record<ElevationSource, string> = {
  geolocation: "GPS (ellipsoidal)",
  terrain: "terrain lookup",
  override: "set by you",
};

export function formatElevationM(
  meters: number | null | undefined,
  source?: ElevationSource | string | null,
): string | null {
  if (meters == null || !Number.isFinite(meters)) return null;
  const rounded = Math.round(meters * 10) / 10;
  const label =
    source && source in ELEVATION_SOURCE_LABEL
      ? ELEVATION_SOURCE_LABEL[source as ElevationSource]
      : null;
  return label ? `${rounded} m (${label})` : `${rounded} m`;
}

/**
 * Open-Meteo elevation at a pin. Returns null on any failure — never invent 0.
 * Open-Meteo sees the requested lat/lng (same privacy rule as imagery).
 */
export async function lookupTerrainElevation(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const url = new URL("https://api.open-meteo.com/v1/elevation");
  url.searchParams.set("latitude", latitude.toFixed(6));
  url.searchParams.set("longitude", longitude.toFixed(6));
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { elevation?: unknown };
    const raw = Array.isArray(body.elevation) ? body.elevation[0] : body.elevation;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  } catch {
    return null;
  }
}
