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

export const IDENTITY_REGISTRATION: CanvasRegistration = {
  originX: 0,
  originY: 0,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  scale: 1,
};

export function standHasGps(stand: StandGeometry): boolean {
  return (
    typeof stand.latitude === "number" &&
    Number.isFinite(stand.latitude) &&
    typeof stand.longitude === "number" &&
    Number.isFinite(stand.longitude)
  );
}

export function bakeStandsToGps(
  stands: StandGeometry[],
  pin: { lat: number; lng: number },
  reg: CanvasRegistration,
): StandGeometry[] {
  return stands.map((stand) => {
    if (standHasGps(stand)) return stand;
    const center = standCenter(stand);
    const ll = canvasToLatLng(center.x, center.y, pin, reg);
    return { ...stand, latitude: ll.lat, longitude: ll.lng };
  });
}

/** Place a GPS stand so its center sits at the right canvas point for `pin`. */
export function alignStandToPin(
  stand: StandGeometry,
  pin: { lat: number; lng: number },
): StandGeometry {
  if (!standHasGps(stand)) return stand;
  const southM = (pin.lat - stand.latitude!) * METERS_PER_DEG_LAT;
  const eastM = (stand.longitude! - pin.lng) * metersPerDegLng(pin.lat);
  const { w, h } = standSize(stand);
  return {
    ...stand,
    x: eastM * PX_PER_METER - w / 2,
    y: southM * PX_PER_METER - h / 2,
  };
}

export function yardCentroid(
  stands: StandGeometry[],
): { lat: number; lng: number } | null {
  const located = stands.filter(standHasGps);
  if (located.length === 0) return null;
  let lat = 0;
  let lng = 0;
  for (const stand of located) {
    lat += stand.latitude!;
    lng += stand.longitude!;
  }
  return { lat: lat / located.length, lng: lng / located.length };
}

export function translateStandGps(
  stand: StandGeometry,
  dLat: number,
  dLng: number,
): StandGeometry {
  if (!standHasGps(stand)) return stand;
  return {
    ...stand,
    latitude: stand.latitude! + dLat,
    longitude: stand.longitude! + dLng,
  };
}

export function slotLatLng(
  stand: StandGeometry,
  row: number,
  col: number,
  pin: { lat: number; lng: number },
  reg: CanvasRegistration,
): { lat: number; lng: number } {
  if (standHasGps(stand)) {
    const { w, h } = standSize(stand);
    const localX = col * CELL_SIZE + CELL_SIZE / 2 - w / 2;
    const localY = row * CELL_SIZE + CELL_SIZE / 2 - h / 2;
    const rad = (stand.rotation * Math.PI) / 180;
    return offsetLatLng(
      stand.latitude!,
      stand.longitude!,
      (localX * Math.cos(rad) - localY * Math.sin(rad)) / PX_PER_METER,
      (localX * Math.sin(rad) + localY * Math.cos(rad)) / PX_PER_METER,
    );
  }
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
 * Fractional container point. Leaflet's latLngToContainerPoint rounds to
 * integers so a 1 m sample (or the pin itself) snaps by half a pixel —
 * at low zoom that is tens of meters and the yard jumps when tiles swap.
 */
export function containerPointPrecise(
  map: LeafletMap,
  lat: number,
  lng: number,
  view?: CanvasMapView,
): { x: number; y: number } {
  const zoom = view?.zoom ?? map.getZoom();
  const center = view
    ? { lat: view.centerLat, lng: view.centerLng }
    : map.getCenter();
  const size = map.getSize();
  const projected = map.project([lat, lng], zoom);
  const projectedCenter = map.project([center.lat, center.lng], zoom);
  return {
    x: projected.x - projectedCenter.x + size.x / 2,
    y: projected.y - projectedCenter.y + size.y / 2,
  };
}

/** Unrounded Web Mercator pixels per ground meter at the pin. */
export function pixelsPerMeter(
  map: LeafletMap,
  pin: { lat: number; lng: number },
  zoom?: number,
): number {
  const z = zoom ?? map.getZoom();
  const baselineM = 100;
  const east = offsetLatLng(pin.lat, pin.lng, baselineM, 0);
  const a = map.project([pin.lat, pin.lng], z);
  const b = map.project([east.lat, east.lng], z);
  return a.distanceTo(b) / baselineM;
}

/**
 * Konva layer transform so canvas world coords stay nailed to lat/lng
 * while Leaflet pans and zooms (including overzoom past native tiles).
 */
export function overlayTransform(
  map: LeafletMap,
  pin: { lat: number; lng: number },
  reg: CanvasRegistration,
  view?: CanvasMapView,
): GeoOverlayTransform {
  const zoom = view?.zoom ?? map.getZoom();
  const originGeo = offsetLatLng(
    pin.lat,
    pin.lng,
    reg.offsetX / PX_PER_METER,
    reg.offsetY / PX_PER_METER,
  );
  const originPt = containerPointPrecise(map, originGeo.lat, originGeo.lng, view);
  const canvasToScreen = (pixelsPerMeter(map, pin, zoom) / PX_PER_METER) * reg.scale;
  return {
    x: originPt.x,
    y: originPt.y,
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
  const ppm = pixelsPerMeter(map, pin);
  if (ppm < 1e-9) return { offsetX: reg.offsetX, offsetY: reg.offsetY };
  const pxPerCanvas = ppm / PX_PER_METER;
  return {
    offsetX: reg.offsetX + dxScreen / pxPerCanvas,
    offsetY: reg.offsetY + dyScreen / pxPerCanvas,
  };
}
