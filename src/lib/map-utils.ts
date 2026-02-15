/**
 * Map tile utilities for OpenStreetMap satellite overlay
 *
 * OpenStreetMap tile URL pattern: https://tile.openstreetmap.org/{z}/{x}/{y}.png
 * Reference: https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
 */

/**
 * Convert latitude/longitude to tile x/y coordinates
 *
 * @param lat - Latitude in degrees
 * @param lng - Longitude in degrees
 * @param zoom - Zoom level (0-19)
 * @returns Tile coordinates {x, y}
 */
export function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);

  return { x, y };
}

/**
 * Get OpenStreetMap tile URL for given coordinates and zoom level
 *
 * @param lat - Latitude in degrees
 * @param lng - Longitude in degrees
 * @param zoom - Zoom level (0-19, typically 15-18 for apiaries)
 * @returns OSM tile URL
 */
export function getTileUrl(lat: number, lng: number, zoom: number): string {
  const { x, y } = latLngToTile(lat, lng, zoom);
  return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
}

/**
 * Get recommended zoom level based on canvas dimensions
 *
 * @param canvasWidth - Canvas width in pixels
 * @param canvasHeight - Canvas height in pixels
 * @returns Recommended OSM zoom level (15-18)
 */
export function getRecommendedZoom(canvasWidth: number, canvasHeight: number): number {
  // For typical apiary layouts (50-200m area):
  // - Zoom 18: ~76m per tile (most detailed)
  // - Zoom 17: ~153m per tile
  // - Zoom 16: ~305m per tile
  // - Zoom 15: ~611m per tile

  const avgDimension = (canvasWidth + canvasHeight) / 2;

  if (avgDimension >= 800) return 18; // High detail for large canvases
  if (avgDimension >= 600) return 17;
  if (avgDimension >= 400) return 16;
  return 15; // Lower detail for smaller canvases
}
