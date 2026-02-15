export type HivePlacement = "full" | "top" | "bottom" | "left" | "right" | "third-1" | "third-2" | "third-3";

export interface SlotHive {
  hiveId: string;
  facingDegrees: number;
  placement: HivePlacement;
  stackLabel?: string;
}

export interface Slot {
  row: number;
  col: number;
  hives: SlotHive[];
}

export interface Stand {
  id: string;
  label: string;
  x: number;
  y: number;
  rotation: number;
  rows: number;
  cols: number;
  slots: Slot[];
}

export interface CanvasLayout {
  stands?: Stand[];
  northArrow?: { x: number; y: number; rotation: number };
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
  // Legacy flat hive positions for migration
  hives?: Record<string, { x: number; y: number }>;
}

export function createEmptyStand(label: string, rows: number, cols: number, x: number, y: number): Stand {
  const slots: Slot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({ row: r, col: c, hives: [] });
    }
  }
  return {
    id: crypto.randomUUID(),
    label,
    x,
    y,
    rotation: 0,
    rows,
    cols,
    slots,
  };
}

export function getSlotLabel(standLabel: string, row: number, col: number, cols: number): string {
  const slotIndex = row * cols + col + 1;
  return `${standLabel}${slotIndex}`;
}

export function getNextStandLabel(existingStands: Stand[]): string {
  const used = new Set(existingStands.map((s) => s.label));
  for (let i = 0; i < 26; i++) {
    const label = String.fromCharCode(65 + i);
    if (!used.has(label)) return label;
  }
  return `S${existingStands.length + 1}`;
}
