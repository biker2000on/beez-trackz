import type { HivePlacement, StandGeometry } from "./types";

/** World pixels per slot cell. One cell ≈ one hive footprint (~0.75 m). */
export const CELL_SIZE = 60;
export const CELL_PADDING = 4;
export const METERS_PER_CELL = 0.75;
export const PX_PER_METER = CELL_SIZE / METERS_PER_CELL;

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.1;
export const GRID_SIZE = 40;

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

export function standSize(stand: StandGeometry): { w: number; h: number } {
  return { w: stand.cols * CELL_SIZE, h: stand.rows * CELL_SIZE };
}

export function standCenter(stand: StandGeometry): { x: number; y: number } {
  const { w, h } = standSize(stand);
  return { x: stand.x + w / 2, y: stand.y + h / 2 };
}

/**
 * Find the slot under a world-coordinate point, accounting for stand
 * rotation (the stand rotates around its center). Returns null when the
 * point falls outside the stand.
 */
export function slotAtPoint(
  stand: StandGeometry,
  worldX: number,
  worldY: number,
): { row: number; col: number } | null {
  const { w, h } = standSize(stand);
  const { x: cx, y: cy } = standCenter(stand);
  const rad = -stand.rotation * (Math.PI / 180);
  const dx = worldX - cx;
  const dy = worldY - cy;
  const localX = dx * Math.cos(rad) - dy * Math.sin(rad) + w / 2;
  const localY = dx * Math.sin(rad) + dy * Math.cos(rad) + h / 2;
  if (localX < 0 || localX >= w || localY < 0 || localY >= h) return null;
  return {
    col: Math.floor(localX / CELL_SIZE),
    row: Math.floor(localY / CELL_SIZE),
  };
}

/** Angle in degrees (0 = north/up, clockwise) from a pivot to a point. */
export function angleFromPivot(
  pivot: { x: number; y: number },
  point: { x: number; y: number },
): number {
  const angle =
    Math.atan2(point.x - pivot.x, -(point.y - pivot.y)) * (180 / Math.PI);
  return ((angle % 360) + 360) % 360;
}

/** Bounding box of all stands, or null when there are none. */
export function standsBoundingBox(
  stands: StandGeometry[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (stands.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stand of stands) {
    const { w, h } = standSize(stand);
    minX = Math.min(minX, stand.x);
    minY = Math.min(minY, stand.y);
    maxX = Math.max(maxX, stand.x + w);
    maxY = Math.max(maxY, stand.y + h);
  }
  return { minX, minY, maxX, maxY };
}

/** Rectangle a hive occupies inside its cell, based on placement. */
export function placementRect(
  placement: HivePlacement,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
): { x: number; y: number; w: number; h: number } {
  const p = CELL_PADDING;
  switch (placement) {
    case "top":
      return { x: cellX + p, y: cellY + p, w: cellW - p * 2, h: cellH / 2 - p * 1.5 };
    case "bottom":
      return { x: cellX + p, y: cellY + cellH / 2 + p * 0.5, w: cellW - p * 2, h: cellH / 2 - p * 1.5 };
    case "left":
      return { x: cellX + p, y: cellY + p, w: cellW / 2 - p * 1.5, h: cellH - p * 2 };
    case "right":
      return { x: cellX + cellW / 2 + p * 0.5, y: cellY + p, w: cellW / 2 - p * 1.5, h: cellH - p * 2 };
    default:
      return { x: cellX + p, y: cellY + p, w: cellW - p * 2, h: cellH - p * 2 };
  }
}

/** Entrance-facing arrow endpoints (0° = north/up, clockwise). */
export function facingArrow(
  facingDegrees: number,
  cx: number,
  cy: number,
  size: number,
): { startX: number; startY: number; endX: number; endY: number } {
  const rad = (facingDegrees - 90) * (Math.PI / 180);
  const len = size * 0.35;
  return {
    startX: cx,
    startY: cy,
    endX: cx + Math.cos(rad) * len,
    endY: cy + Math.sin(rad) * len,
  };
}
