/**
 * Switchable Leaflet raster layers. Streets use OpenStreetMap's standard
 * tile service; imagery stays on Esri World Imagery. Both providers require
 * visible attribution, supplied here and rendered by Leaflet's attribution
 * control. Adding a layer later is a URL + attribution +
 * who-sees-the-coords note — not a new renderer.
 *
 * Whoever serves tiles sees the requested tile coordinates, which locate
 * the yard to roughly a few hundred meters. Documented in the README.
 */

export type TileLayerId = "imagery" | "streets";

export interface TileLayerDef {
  id: TileLayerId;
  label: string;
  /** Hosts that receive tile requests (and therefore the yard's coords). */
  seenBy: string;
  url: string;
  attribution: string;
  maxNativeZoom: number;
  maxZoom: number;
}

/**
 * Leaflet overzoom past the last real tile. At native z19 a 0.75 m hive
 * cell is ~2–3 px; the Konva overlay needs z24 (~80 px/cell) to be usable.
 * Tiles scale up (blurry) after maxNativeZoom.
 */
export const YARD_MAX_ZOOM = 24;

export const TILE_LAYERS: Record<TileLayerId, TileLayerDef> = {
  imagery: {
    id: "imagery",
    label: "Imagery",
    seenBy: "Esri / ArcGIS Online (server.arcgisonline.com)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxNativeZoom: 19,
    maxZoom: YARD_MAX_ZOOM,
  },
  streets: {
    id: "streets",
    label: "Streets",
    seenBy: "OpenStreetMap (tile.openstreetmap.org)",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxNativeZoom: 19,
    maxZoom: YARD_MAX_ZOOM,
  },
};

/** Default for stand registration — the canvas already used this imagery. */
export const DEFAULT_TILE_LAYER: TileLayerId = "imagery";
