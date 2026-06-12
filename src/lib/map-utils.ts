/**
 * Satellite tile utilities (Esri World Imagery via the slippy-map tiling
 * scheme). The canvas has a real-world scale (PX_PER_METER), so tiles are
 * georeferenced into world coordinates and pan/zoom with the stage.
 */

export const TILE_SIZE = 256;
export const SATELLITE_ZOOM = 19;

/** Esri World Imagery — free for this kind of lightweight use. */
export function getTileUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

/** Fractional slippy-map tile coordinates for a lat/lng at zoom z. */
export function latLngToTileFraction(
  lat: number,
  lng: number,
  zoom: number
): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

/** Ground meters covered by one tile edge at this latitude and zoom. */
export function metersPerTile(lat: number, zoom: number): number {
  const metersPerPixel =
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  return metersPerPixel * TILE_SIZE;
}

export interface PlacedTile {
  url: string;
  /** World-coordinate position of the tile's top-left corner. */
  x: number;
  y: number;
  /** World-coordinate edge length. */
  size: number;
  key: string;
}

/**
 * Compute a (2r+1)² mosaic of tiles centered on the apiary location,
 * positioned in canvas world coordinates such that the apiary lat/lng sits
 * at `anchor`.
 */
export function buildTileMosaic(params: {
  lat: number;
  lng: number;
  zoom: number;
  pxPerMeter: number;
  anchor: { x: number; y: number };
  radius?: number;
}): PlacedTile[] {
  const { lat, lng, zoom, pxPerMeter, anchor, radius = 1 } = params;
  const frac = latLngToTileFraction(lat, lng, zoom);
  const tileWorldSize = metersPerTile(lat, zoom) * pxPerMeter;
  const centerX = Math.floor(frac.x);
  const centerY = Math.floor(frac.y);

  const tiles: PlacedTile[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = centerX + dx;
      const ty = centerY + dy;
      tiles.push({
        url: getTileUrl(zoom, tx, ty),
        x: anchor.x + (tx - frac.x) * tileWorldSize,
        y: anchor.y + (ty - frac.y) * tileWorldSize,
        size: tileWorldSize,
        key: `${zoom}/${tx}/${ty}`,
      });
    }
  }
  return tiles;
}
