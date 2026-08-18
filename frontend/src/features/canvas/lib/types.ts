/**
 * Canvas domain types.
 *
 * Two-tier persistence:
 * - Stand geometry, the north arrow, and the viewport live in the apiary's
 *   `canvasLayout` JSON blob (local reducer state, saved via
 *   PUT /apiaries/{id}/canvas-layout).
 * - Hive↔slot occupancy is relational (hives.standId/slotRow/slotCol/
 *   placement) and is written through immediately via the canvas API.
 */

export type HivePlacement = "full" | "top" | "bottom" | "left" | "right";

export type HiveStatus = "active" | "dead" | "sold" | "combined";

/** Hive shape returned by GET /hives (the fields the canvas cares about). */
export interface CanvasHive {
  id: string;
  apiaryId: string;
  positionLabel: string;
  standId: string | null;
  slotRow: number | null;
  slotCol: number | null;
  placement: HivePlacement | null;
  facingDegrees: number | null;
  status: string;
  notes: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** Persisted stand geometry — occupancy is derived at render time. */
export interface StandGeometry {
  id: string;
  label: string;
  x: number;
  y: number;
  rotation: number;
  rows: number;
  cols: number;
  /** Center of the stand. Set once the yard has a map location. */
  latitude?: number;
  longitude?: number;
}

export interface NorthArrowState {
  x: number;
  y: number;
  rotation: number;
}

/** Stand-layer transform relative to the apiary pin. */
export interface CanvasRegistration {
  originX: number;
  originY: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  scale: number;
}

export interface CanvasMapView {
  centerLat: number;
  centerLng: number;
  zoom: number;
}

/** The geometry-only blob persisted to apiaries.canvasLayout. */
export interface CanvasLayout {
  stands?: StandGeometry[];
  northArrow?: NorthArrowState;
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
  registration?: CanvasRegistration;
  mapView?: CanvasMapView;
}

/** A hive occupying a slot (derived, never persisted). */
export interface SlotHive {
  hiveId: string;
  facingDegrees: number;
  placement: HivePlacement;
}

/** Derived occupancy of one slot. */
export interface Slot {
  row: number;
  col: number;
  hives: SlotHive[];
}

/** A concrete slot on a concrete stand, used as a move/assign target. */
export interface SlotTarget {
  standId: string;
  standLabel: string;
  standCols: number;
  row: number;
  col: number;
  label: string;
}

export const STAND_MIN_DIM = 1;
export const STAND_MAX_DIM = 8;
export const STAND_LABEL_MAX = 4;

/** Slot label, e.g. stand "A" 2×4 grid row 1 col 2 → "A7". */
export function getSlotLabel(
  standLabel: string,
  row: number,
  col: number,
  cols: number,
): string {
  return `${standLabel}${row * cols + col + 1}`;
}

/** Next free single-letter label: A, B, C, … then S9, S10, … */
export function getNextStandLabel(existing: StandGeometry[]): string {
  const used = new Set(existing.map((s) => s.label));
  for (let i = 0; i < 26; i++) {
    const label = String.fromCharCode(65 + i);
    if (!used.has(label)) return label;
  }
  return `S${existing.length + 1}`;
}

export function createStandGeometry(
  label: string,
  rows: number,
  cols: number,
  x: number,
  y: number,
  gps?: { latitude: number; longitude: number },
): StandGeometry {
  return {
    id: crypto.randomUUID(),
    label,
    x,
    y,
    rotation: 0,
    rows,
    cols,
    latitude: gps?.latitude,
    longitude: gps?.longitude,
  };
}

const PLACEMENTS: HivePlacement[] = ["full", "top", "bottom", "left", "right"];

function asPlacement(value: unknown): HivePlacement {
  return PLACEMENTS.includes(value as HivePlacement)
    ? (value as HivePlacement)
    : "full";
}

/**
 * Parse a raw canvasLayout blob defensively. Unknown fields (including any
 * legacy embedded occupancy) are dropped; malformed stands are skipped.
 */
export function parseCanvasLayout(raw: unknown): Required<
  Pick<CanvasLayout, "stands">
> &
  Omit<CanvasLayout, "stands"> {
  const layout: ReturnType<typeof parseCanvasLayout> = { stands: [] };
  if (typeof raw !== "object" || raw === null) return layout;
  const blob = raw as Record<string, unknown>;

  if (Array.isArray(blob.stands)) {
    for (const item of blob.stands) {
      if (typeof item !== "object" || item === null) continue;
      const s = item as Record<string, unknown>;
      if (typeof s.id !== "string" || typeof s.label !== "string") continue;
      if (typeof s.x !== "number" || typeof s.y !== "number") continue;
      const rows = typeof s.rows === "number" ? s.rows : NaN;
      const cols = typeof s.cols === "number" ? s.cols : NaN;
      if (!Number.isFinite(rows) || !Number.isFinite(cols)) continue;
      const latitude = typeof s.latitude === "number" ? s.latitude : undefined;
      const longitude = typeof s.longitude === "number" ? s.longitude : undefined;
      layout.stands.push({
        id: s.id,
        label: s.label,
        x: s.x,
        y: s.y,
        rotation: typeof s.rotation === "number" ? s.rotation : 0,
        rows: Math.min(STAND_MAX_DIM, Math.max(STAND_MIN_DIM, Math.round(rows))),
        cols: Math.min(STAND_MAX_DIM, Math.max(STAND_MIN_DIM, Math.round(cols))),
        ...(latitude != null && longitude != null ? { latitude, longitude } : {}),
      });
    }
  }

  const arrow = blob.northArrow as Record<string, unknown> | undefined;
  if (
    arrow &&
    typeof arrow.x === "number" &&
    typeof arrow.y === "number"
  ) {
    layout.northArrow = {
      x: arrow.x,
      y: arrow.y,
      rotation: typeof arrow.rotation === "number" ? arrow.rotation : 0,
    };
  }

  if (typeof blob.zoom === "number") layout.zoom = blob.zoom;
  if (typeof blob.offsetX === "number") layout.offsetX = blob.offsetX;
  if (typeof blob.offsetY === "number") layout.offsetY = blob.offsetY;

  const reg = blob.registration as Record<string, unknown> | undefined;
  if (reg && typeof reg.originX === "number" && typeof reg.originY === "number") {
    const scale = typeof reg.scale === "number" && reg.scale > 0 ? reg.scale : 1;
    layout.registration = {
      originX: reg.originX,
      originY: reg.originY,
      offsetX: typeof reg.offsetX === "number" ? reg.offsetX : 0,
      offsetY: typeof reg.offsetY === "number" ? reg.offsetY : 0,
      rotation: typeof reg.rotation === "number" ? reg.rotation : 0,
      scale,
    };
  }

  const view = blob.mapView as Record<string, unknown> | undefined;
  if (
    view &&
    typeof view.centerLat === "number" &&
    typeof view.centerLng === "number" &&
    typeof view.zoom === "number"
  ) {
    layout.mapView = {
      centerLat: view.centerLat,
      centerLng: view.centerLng,
      zoom: view.zoom,
    };
  }
  return layout;
}

/**
 * Build per-stand slot occupancy from the hives' relational columns.
 * Hives whose stand is missing (null standId, deleted stand, or a slot
 * outside the stand's current grid) are returned in `unassigned`.
 */
export function buildSlotOccupancy(
  stands: StandGeometry[],
  hives: CanvasHive[],
): { slotsByStand: Map<string, Slot[]>; unassigned: CanvasHive[] } {
  const slotsByStand = new Map<string, Slot[]>();
  for (const stand of stands) {
    const slots: Slot[] = [];
    for (let r = 0; r < stand.rows; r++) {
      for (let c = 0; c < stand.cols; c++) {
        slots.push({ row: r, col: c, hives: [] });
      }
    }
    slotsByStand.set(stand.id, slots);
  }

  const unassigned: CanvasHive[] = [];
  for (const hive of hives) {
    // Dead hives with no assignment have left the yard — don't nag about them.
    if (hive.status === "dead" && hive.standId == null) continue;
    const slots = hive.standId ? slotsByStand.get(hive.standId) : undefined;
    const slot =
      slots && hive.slotRow != null && hive.slotCol != null
        ? slots.find((s) => s.row === hive.slotRow && s.col === hive.slotCol)
        : undefined;
    if (!slot) {
      unassigned.push(hive);
      continue;
    }
    slot.hives.push({
      hiveId: hive.id,
      facingDegrees: hive.facingDegrees ?? 0,
      placement: asPlacement(hive.placement),
    });
  }

  return { slotsByStand, unassigned };
}
