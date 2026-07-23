/** Response shapes for the equipment API (routes_equipment.go). */

export type EquipmentCategory =
  | "box"
  | "frame"
  | "cover"
  | "bottom"
  | "accessory"
  | "other";

export const CATEGORY_ORDER: EquipmentCategory[] = [
  "box",
  "frame",
  "cover",
  "bottom",
  "accessory",
  "other",
];

export const CATEGORY_LABELS: Record<EquipmentCategory, string> = {
  box: "Boxes",
  frame: "Frames",
  cover: "Covers",
  bottom: "Bottom boards",
  accessory: "Accessories",
  other: "Other",
};

export const ADJUSTMENT_REASONS = [
  "purchased",
  "built",
  "discarded",
  "broken",
  "gifted",
  "other",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export interface EquipmentType {
  id: string;
  name: string;
  category: EquipmentCategory;
  framesPerBox: number | null;
  isDefault: boolean;
  createdAt: string;
}

export interface EquipmentStockRow {
  id: string;
  typeId: string;
  typeName: string;
  typeCategory: EquipmentCategory;
  totalOwned: number;
  storageLocation: string | null;
  notes: string | null;
  frameCondition: "drawn" | "fresh" | null;
  framesPerBox: number | null;
  deployed: number;
  available: number;
}

export interface StockAdjustment {
  id: string;
  stockId: string;
  quantity: number;
  reason: string;
  notes: string | null;
  date: string;
  createdAt: string;
}

export interface ActiveDeployment {
  id: string;
  stockId: string;
  quantity: number;
  hiveLabel: string;
  typeName: string;
  typeCategory: EquipmentCategory;
}

export interface FrameSummary {
  standalone: {
    drawn: number;
    fresh: number;
    unspecified: number;
    total: number;
  };
  boxFrameCapacity: number;
  boxBreakdown: {
    boxType: string;
    framesPerBox: number;
    deployedBoxes: number;
    totalFrameCapacity: number;
  }[];
  grandTotal: number;
}

/** Minimal hive shape used for the deploy-to-hive select (GET /hives). */
export interface HiveOption {
  id: string;
  apiaryId: string;
  apiaryName: string;
  positionLabel: string;
  status: string;
}
