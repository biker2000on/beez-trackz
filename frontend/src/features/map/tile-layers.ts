/**
 * Switchable Leaflet raster layers. Adding a layer later is a URL +
 * attribution + who-sees-the-coords note — not a new renderer.
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

export const TILE_LAYERS: Record<TileLayerId, TileLayerDef> = {
  imagery: {
    id: "imagery",
    label: "Imagery",
    seenBy: "Esri / ArcGIS Online (server.arcgisonline.com)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxNativeZoom: 19,
    maxZoom: 20,
  },
  streets: {
    id: "streets",
    label: "Streets",
    seenBy: "Esri / ArcGIS Online (server.arcgisonline.com)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom",
    maxNativeZoom: 19,
    maxZoom: 20,
  },
};

/** Default for stand registration — the canvas already used this imagery. */
export const DEFAULT_TILE_LAYER: TileLayerId = "imagery";
