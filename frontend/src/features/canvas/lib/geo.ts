import type { Map as LeafletMap } from "leaflet";

import { CELL_SIZE, PX_PER_METER, standCenter, standSize } from "./geometry";
import type {
  CanvasMapView,
  CanvasRegistration,
  StandGeometry,
} from "./types";

export type { CanvasMapView, CanvasRegistration };

export const DEFAULT_REGISTRATION: Omit<
  CanvasRegistration,
  "originX" | "originY"
> = {
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  scale: 1,
};

const METERS_PER_DEG_LAT = 111_320;

export function defaultOrigin(stands: StandGeometry[]): { x: number; y: number } {
  if (stands.length === 0) return { x: 300, y: 200 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stand of stands) {
    minX = Math.min(minX, stand.x);
    minY = Math.min(minY, stand.y);
    maxX = Math.max(maxX, stand.x + stand.cols * CELL_SIZE);
    maxY = Math.max(maxY, stand.y + stand.rows * CELL_SIZE);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

export function resolveRegistration(
  raw: CanvasRegistration | undefined,
  stands: StandGeometry[],
): CanvasRegistration {
  const origin = defaultOrigin(stands);
  const scale =
    raw && Number.isFinite(raw.scale) && raw.scale > 0 ? raw.scale : 1;
  return {
    originX: raw && Number.isFinite(raw.originX) ? raw.originX : origin.x,
    originY: raw && Number.isFinite(raw.originY) ? raw.originY : origin.y,
    offsetX: raw && Number.isFinite(raw.offsetX) ? raw.offsetX : 0,
    offsetY: raw && Number.isFinite(raw.offsetY) ? raw.offsetY : 0,
    rotation: raw && Number.isFinite(raw.rotation) ? raw.rotation : 0,
    scale,
  };
}

export function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Offset a pin by local east/south meters (equirectangular / local tangent). */
export function offsetLatLng(
  lat: number,
  lng: number,
  eastM: number,
  southM: number,
): { lat: number; lng: number } {
  return {
    lat: lat - southM / METERS_PER_DEG_LAT,
    lng: lng + eastM / metersPerDegLng(lat),
  };
}

/**
 * Apply registration to a canvas world point, then project onto the pin.
 * Canvas +x is east, +y is south (screen convention, matches Web Mercator).
 */
export function canvasToLatLng(
  worldX: number,
  worldY: number,
  pin: { lat: number; lng: number },
  reg: CanvasRegistration,
): { lat: number; lng: number } {
  const dx = worldX - reg.originX;
  const dy = worldY - reg.originY;
  const rad = (reg.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = (dx * cos - dy * sin) * reg.scale + reg.offsetX;
  const ry = (dx * sin + dy * cos) * reg.scale + reg.offsetY;
  return offsetLatLng(pin.lat, pin.lng, rx / PX_PER_METER, ry / PX_PER_METER);
}

/** Center of a slot in canvas world coordinates (rotation-aware). */
export function slotWorldCenter(
  stand: StandGeometry,
  row: number,
  col: number,
): { x: number; y: number } {
  const { w, h } = standSize(stand);
  const center = standCenter(stand);
  const localX = col * CELL_SIZE + CELL_SIZE / 2 - w / 2;
  const localY = row * CELL_SIZE + CELL_SIZE / 2 - h / 2;
  const rad = (stand.rotation * Math.PI) / 180;
  return {
    x: center.x + localX * Math.cos(rad) - localY * Math.sin(rad),
    y: center.y + localX * Math.sin(rad) + localY * Math.cos(rad),
  };
}

export function slotLatLng(
  stand: StandGeometry,
  row: number,
  col: number,
  pin: { lat: number; lng: number },
  reg: CanvasRegistration,
): { lat: number; lng: number } {
  const world = slotWorldCenter(stand, row, col);
  return canvasToLatLng(world.x, world.y, pin, reg);
}

export interface GeoOverlayTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Konva layer transform so canvas world coords stay nailed to lat/lng
 * while Leaflet pans and zooms (including zoom < 19).
 */
export function overlayTransform(
  map: LeafletMap,
  pin: { lat: number; lng: number },
  reg: CanvasRegistration,
): GeoOverlayTransform {
  const pinPt = map.latLngToContainerPoint([pin.lat, pin.lng]);
  const east = offsetLatLng(pin.lat, pin.lng, 1, 0);
  const eastPt = map.latLngToContainerPoint([east.lat, east.lng]);
  const metersToScreen = Math.hypot(eastPt.x - pinPt.x, eastPt.y - pinPt.y);
  const canvasToScreen = (metersToScreen / PX_PER_METER) * reg.scale;

  const offX = reg.offsetX * (metersToScreen / PX_PER_METER);
  const offY = reg.offsetY * (metersToScreen / PX_PER_METER);
  // Place the registration origin at pin + unrotated offset, then let
  // Konva rotate about that point. Rotating the offset around the pin
  // made the stands orbit whatever was off-screen after a nudge/pan.
  return {
    x: pinPt.x + offX,
    y: pinPt.y + offY,
    scaleX: canvasToScreen,
    scaleY: canvasToScreen,
    rotation: reg.rotation,
    offsetX: reg.originX,
    offsetY: reg.originY,
  };
}

/** Convert a screen-pixel drag on the locked map into a registration nudge. */
export function screenDeltaToRegistrationOffset(
  map: LeafletMap,
  pin: { lat: number; lng: number },
  reg: CanvasRegistration,
  dxScreen: number,
  dyScreen: number,
): { offsetX: number; offsetY: number } {
  const pinPt = map.latLngToContainerPoint([pin.lat, pin.lng]);
  const east = offsetLatLng(pin.lat, pin.lng, 1, 0);
  const eastPt = map.latLngToContainerPoint([east.lat, east.lng]);
  const metersToScreen = Math.hypot(eastPt.x - pinPt.x, eastPt.y - pinPt.y);
  if (metersToScreen < 1e-6) return { offsetX: reg.offsetX, offsetY: reg.offsetY };
  const pxPerCanvas = metersToScreen / PX_PER_METER;
  return {
    offsetX: reg.offsetX + dxScreen / pxPerCanvas,
    offsetY: reg.offsetY + dyScreen / pxPerCanvas,
  };
}
