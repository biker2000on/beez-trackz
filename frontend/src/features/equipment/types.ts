/** Response shapes for the equipment API (routes_equipment.go).

Identity fields follow the ledger: stock rows are keyed by inventory item
id, history/deploy/loss rows by operation id, and assembly returns
`operationId`. Handlers still serialize some item ids as `stockId` on the
wire; `ledgerItemId` accepts either key.
*/

/** Item identity from a handler that may still tag it `stockId`. */
export function ledgerItemId(row: {
  itemId?: string | null;
  stockId?: string | null;
}): string {
  return row.itemId || row.stockId || "";
}

export type EquipmentCategory =
  | "box"
  | "frame"
  | "cover"
  | "bottom"
  | "accessory"
  | "packaging"
  | "other";

export const CATEGORY_ORDER: EquipmentCategory[] = [
  "box",
  "frame",
  "cover",
  "bottom",
  "accessory",
  "packaging",
  "other",
];

export const CATEGORY_LABELS: Record<EquipmentCategory, string> = {
  box: "Boxes",
  frame: "Frames",
  cover: "Covers",
  bottom: "Bottom boards",
  accessory: "Accessories",
  packaging: "Packaging",
  other: "Other",
};

/** Reasons a manual ± adjustment may carry. */
export const ADJUSTMENT_REASONS = [
  "purchased",
  "built",
  "discarded",
  "broken",
  "gifted",
  "other",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/** Reasons for receiving equipment into stock. */
export const RECEIVE_REASONS = ["purchased", "built"] as const;

/** Reasons a unit changes condition state. */
export const STATE_REASONS = [
  "broken",
  "worn_out",
  "pest_damage",
  "weather",
  "lost",
  "obsolete",
  "repaired",
  "sold",
  "disposed",
  "other",
] as const;

export const RETURN_REASONS = [
  "season_end",
  "no_longer_needed",
  "maintenance",
  "damaged",
  "hive_removed",
  "other",
  "sold_with_hive",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_CONDITIONS = ["good", "damaged", "retired"] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

/** Human labels for the machine-readable reason and condition values. */
export const REASON_LABELS: Record<string, string> = {
  purchased: "Purchased",
  built: "Built",
  discarded: "Discarded",
  broken: "Broken",
  gifted: "Gifted",
  other: "Other",
  physical_count: "Physical count",
  assembled: "Assembled",
  disassembled: "Disassembled",
  worn_out: "Worn out",
  pest_damage: "Pest damage",
  weather: "Weather",
  lost: "Lost",
  obsolete: "Obsolete",
  repaired: "Repaired",
  sold: "Sold",
  disposed: "Disposed",
  returned_damaged: "Returned damaged",
  season_end: "End of season",
  no_longer_needed: "No longer needed",
  maintenance: "Maintenance",
  hive_removed: "Hive removed",
  sold_with_hive: "Sold with hive",
};

export const CONDITION_LABELS: Record<ReturnCondition, string> = {
  good: "Good — back in service",
  damaged: "Damaged — needs repair",
  retired: "Retired — out of service",
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

export interface EquipmentType {
  id: string;
  name: string;
  category: EquipmentCategory;
  framesPerBox: number | null;
  isDefault: boolean;
  /** Set when this type is a variety of a base type (e.g. migratory cover). */
  variantOfTypeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One bill-of-materials line: parent is built from N of the component type. */
export interface EquipmentComponentLine {
  id: string;
  parentTypeId: string;
  parentTypeName: string;
  componentTypeId: string;
  componentTypeName: string;
  quantity: number;
}

export interface EquipmentStockRow {
  /** inventory_items.id (GET /equipment/stock still keys the row as `id`). */
  id: string;
  typeId: string;
  typeName: string;
  typeCategory: EquipmentCategory;
  /** Everything owned, whatever condition it is in. */
  totalOwned: number;
  storageLocation: string | null;
  notes: string | null;
  frameCondition: "drawn" | "fresh" | null;
  framesPerBox: number | null;
  /** Still out on a hive. */
  deployed: number;
  /** Owned − deployed − damaged − retired: ready to use. */
  available: number;
  damaged: number;
  retired: number;
  /** Target quantity for the operation. */
  needed: number;
  /** How far short of `needed` the available count is (0 when covered). */
  shortfall: number;
  unitCostCents: number | null;
  firstDeployedYear: number | null;
  combAgeYears: number | null;
  pullRecommended: boolean;
  updatedAt: string;
}

export interface StockAdjustment {
  /** inventory_operations.id */
  id: string;
  itemId: string;
  /** @deprecated handlers still serialize the item as stockId. */
  stockId?: string;
  quantity: number;
  reason: string;
  notes: string | null;
  unitCostCents: number | null;
  date: string;
  createdAt: string;
}

export interface StockStateChange {
  /** inventory_operations.id */
  id: string;
  itemId: string;
  /** @deprecated handlers still serialize the item as stockId. */
  stockId?: string;
  fromState: "serviceable" | "damaged" | "retired";
  toState: "serviceable" | "damaged" | "retired";
  quantity: number;
  reason: string;
  notes: string | null;
  unitCostCents: number | null;
  date: string;
  createdAt: string;
}

export interface ActiveDeployment {
  /** First deploy inventory_operations.id for this item×hive balance. */
  id: string;
  itemId: string;
  /** @deprecated handlers still serialize the item as stockId. */
  stockId?: string;
  quantity: number;
  quantityReturned: number;
  /** Still on the hive. */
  outstanding: number;
  hiveLabel: string;
  typeName: string;
  typeCategory: EquipmentCategory;
  dateDeployed: string;
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

/** One line of a submitted physical count, as the server resolved it. */
export interface PhysicalCountLine {
  itemId: string;
  /** @deprecated handlers still serialize the item as stockId. */
  stockId?: string;
  typeId: string;
  typeName: string;
  previousAvailable: number;
  countedQuantity: number;
  delta: number;
  totalOwned: number;
}

export interface PhysicalCountResult {
  success: boolean;
  counted: number;
  adjusted: number;
  unchanged: number;
  lines: PhysicalCountLine[];
}

export type LossKind = "damaged" | "retired" | "written_off";

export const LOSS_KIND_LABELS: Record<LossKind, string> = {
  damaged: "Damaged",
  retired: "Retired",
  written_off: "Written off",
};

export interface LossReport {
  from: string;
  to: string;
  totals: {
    damaged: number;
    retired: number;
    writtenOff: number;
    valueCents: number;
  };
  byType: {
    typeId: string;
    typeName: string;
    typeCategory: EquipmentCategory;
    damaged: number;
    retired: number;
    writtenOff: number;
    valueCents: number;
  }[];
  events: {
    /** inventory_operations.id */
    id: string;
    itemId: string;
    /** @deprecated handlers still serialize the item as stockId. */
    stockId?: string;
    typeName: string;
    typeCategory: EquipmentCategory;
    kind: LossKind;
    quantity: number;
    reason: string;
    notes: string | null;
    valueCents: number;
    date: string;
  }[];
}

/** POST /equipment/assemblies success body. */
export interface AssembleResult {
  operationId?: string;
  typeId?: string;
  typeName: string;
  action: "assemble" | "disassemble";
  quantity: number;
  replayed?: boolean;
  components?: { typeId: string; typeName: string; quantity: number }[];
}

/** Minimal hive shape used for the deploy-to-hive select (GET /hives). */
export interface HiveOption {
  id: string;
  apiaryId: string;
  apiaryName: string;
  positionLabel: string;
  status: string;
}
