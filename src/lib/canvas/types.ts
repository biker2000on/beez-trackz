export type HivePlacement = "full" | "top" | "bottom" | "left" | "right";

/**
 * A hive as the canvas needs it. Slot assignment comes from the hives
 * table (standId/slotRow/slotCol/placement) — the single source of truth.
 */
export interface CanvasHive {
  id: string;
  positionLabel: string;
  status: string;
  notes?: string | null;
  standId: string | null;
  slotRow: number | null;
  slotCol: number | null;
  placement: HivePlacement | null;
  facingDegrees?: number | null;
}

/** Stand geometry only — occupancy is derived from hives at render time. */
export interface StandGeometry {
  id: string;
  label: string;
  x: number;
  y: number;
  rotation: number;
  rows: number;
  cols: number;
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

/**
 * Persisted canvas layout: geometry and viewport only. The legacy formats
 * (embedded slot occupancy under stands[].slots, or flat `hives` position
 * map) are migrated to relational columns by normalizeCanvasLayout.
 */
export interface CanvasLayout {
  stands?: StandGeometry[];
  northArrow?: { x: number; y: number; rotation: number };
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
}

/** Legacy on-disk shapes, accepted when reading old layouts. */
export interface LegacyStand extends StandGeometry {
  slots?: Array<{
    row: number;
    col: number;
    hives: Array<{ hiveId: string; facingDegrees?: number; placement?: string }>;
  }>;
}
export interface LegacyCanvasLayout extends Omit<CanvasLayout, "stands"> {
  stands?: LegacyStand[];
  hives?: Record<string, { x: number; y: number }>;
}

export function createStandGeometry(
  label: string,
  rows: number,
  cols: number,
  x: number,
  y: number
): StandGeometry {
  return { id: crypto.randomUUID(), label, x, y, rotation: 0, rows, cols };
}

export function getSlotLabel(
  standLabel: string,
  row: number,
  col: number,
  cols: number
): string {
  const slotIndex = row * cols + col + 1;
  return `${standLabel}${slotIndex}`;
}

export function getNextStandLabel(existing: StandGeometry[]): string {
  const used = new Set(existing.map((s) => s.label));
  for (let i = 0; i < 26; i++) {
    const label = String.fromCharCode(65 + i);
    if (!used.has(label)) return label;
  }
  return `S${existing.length + 1}`;
}

/**
 * Build per-stand slot occupancy from the hives' relational columns.
 * Hives whose stored stand no longer exists are returned in `unassigned`.
 */
export function buildSlotOccupancy(
  stands: StandGeometry[],
  hives: CanvasHive[]
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
      placement: (hive.placement as HivePlacement) ?? "full",
    });
  }

  return { slotsByStand, unassigned };
}
