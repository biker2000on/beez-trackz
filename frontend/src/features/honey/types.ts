/** Response shapes for the honey ledger API (routes_honey.go & friends). */

export interface JarSize {
  id: string;
  label: string;
  honeyOz: number | null;
  defaultPrice: number | null;
  sortOrder: number;
  isActive: boolean;
}

export interface HoneyInventoryRow {
  jarSizeId: string;
  label: string;
  honeyOz: number | null;
  defaultPrice: number | null;
  jarred: number;
  sold: number;
  givenAway: number;
  adjusted: number;
  onHand: number;
}

export interface HoneyOverview {
  totalHarvestedLbs: number;
  jarredLbs: number;
  bulkUsedLbs: number;
  lossLbs: number;
  bulkOnHandLbs: number;
  totalRevenue: number;
  jarsSold: number;
  inventory: HoneyInventoryRow[];
}

export type TimelineKind =
  | "jarring"
  | "sale"
  | "bulk_use"
  | "loss"
  | "give_away"
  | "jar_adjustment";

export interface TimelineEntry {
  id: string;
  date: string;
  type: TimelineKind;
  description: string;
  amountLbs: number | null;
  quantity: number | null;
  totalAmount: number | null;
  notes: string | null;
}

export interface SaleLineItem {
  saleId: string;
  jarSizeId: string;
  quantity: number;
  unitPrice: number;
  label: string;
}

export interface HoneySale {
  id: string;
  date: string;
  customerId: string | null;
  harvestLotId: string | null;
  harvestLotCode: string | null;
  customerName: string | null;
  location: string | null;
  channel: string;
  paymentMethod: string;
  totalAmount: number;
  discountAmount: number;
  amountPaid: number;
  orderStatus: string;
  orderNumber: string | null;
  dueDate: string | null;
  notes: string | null;
  createdAt: string;
  lineItems: SaleLineItem[];
}

export interface HarvestRow {
  id: string;
  hiveId: string;
  date: string;
  superWeightBefore: number;
  superWeightAfter: number;
  calculatedHoneyWeight: number;
  notes: string | null;
  hiveName: string;
  apiaryName: string;
}

export interface HarvestSessionRow {
  id: string;
  date: string;
  totalExtractedWeight: number | null;
  notes: string | null;
  apiaryName: string;
  entryCount: number;
  calculatedTotal: number;
}

export interface HarvestSessionEntry {
  id: string;
  hiveId: string;
  superWeightBefore: number;
  superWeightAfter: number;
  calculatedHoneyWeight: number;
  notes: string | null;
  hiveName: string;
}

export interface HarvestSessionDetail {
  id: string;
  apiaryId: string;
  date: string;
  totalExtractedWeight: number | null;
  notes: string | null;
  createdAt: string;
  entries: HarvestSessionEntry[];
  calculatedTotal: number;
  difference: number | null;
}

/** Minimal hive shape used for select lists (GET /hives). */
export interface HiveOption {
  id: string;
  apiaryId: string;
  apiaryName: string;
  positionLabel: string;
  status: string;
}

/** Minimal apiary shape used for select lists (GET /apiaries). */
export interface ApiaryOption {
  id: string;
  name: string;
}
