/**
 * The Production and Sales workbench read models, mirroring design
 * 2026-09-03 §4.8 exactly.
 *
 * Like `features/work/types.ts` this file is a transcription, not an
 * interpretation. Both workbenches are a *single* `GET` (§7 wave 4
 * acceptance: "neither workbench is assembled from more than one call") whose
 * every quantity was read from `inventory_available` / `inventory_balances`
 * server-side. Nothing here recomputes a total, an availability or a
 * permission — the moment the client re-derives one of those it becomes a
 * second rule that can disagree with the ledger, which is the failure the
 * whole item-10 reset exists to remove.
 *
 * `WorkCommand` and `WorkFreshness` are imported rather than redeclared: a
 * workbench command is the same `WorkItemCommand` §4.2 defines, answered for
 * this actor and this offline manifest before it reaches the browser.
 */

import type { WorkCommand, WorkFreshness } from "@/features/work/types";

export type { WorkCommand, WorkFreshness };

/** What every §4.8 read model carries: when it was read, and how fresh. */
export interface WorkbenchEnvelope {
  asOf: string;
  freshness: WorkFreshness;
  /** Workbench-level commands (start session, record bottling, record sale). */
  commands: WorkCommand[];
}

/**
 * A decimal quantity the server sends as a string to keep the ledger's exact
 * scale (`"42.250"`). It is never parsed for arithmetic here, only for
 * display; §4.8 also uses plain numbers for whole counts, so both are
 * accepted and both are formatted by the same helper.
 */
export type Quantity = string | number;

// ---------------------------------------------------------------- production

export interface OpenSession {
  id: string;
  apiaryName: string | null;
  date: string;
  entryCount: number;
  calculatedTotalLbs: Quantity;
  /** Null until the session is trued up (`CheckHarvestResidual`, §3.2 step 4). */
  trueUpDifferenceLbs: Quantity | null;
  commands: WorkCommand[];
}

export interface BulkLot {
  lotId: string;
  lotCode: string;
  varietal: string | null;
  availableLbs: Quantity;
  /** S2, carried forward so the workbench explains a refusal before it happens. */
  lockedOut: boolean;
  lockoutUntil: string | null;
  /**
   * Extension beyond the §4.8 sample: the lockout's own words when the server
   * has them. Absent is fine — the row still states that it is locked out and
   * until when.
   */
  lockoutReason?: string | null;
  commands?: WorkCommand[];
}

export interface AwaitingBottling {
  lotId: string;
  lotCode: string;
  availableLbs: Quantity;
  commands?: WorkCommand[];
}

export interface JarStock {
  jarSizeId: string;
  label: string;
  onHand: number;
  reserved: number;
  available: number;
  parLevel: number | null;
  commands?: WorkCommand[];
}

export interface ProductBatch {
  id: string;
  productName: string;
  onHand: number;
  commands?: WorkCommand[];
}

/** GET /api/v1/production/workbench?year= */
export interface ProductionWorkbenchResponse extends WorkbenchEnvelope {
  openSessions: OpenSession[];
  bulkOnHand: BulkLot[];
  lotsAwaitingBottling: AwaitingBottling[];
  jarStock: JarStock[];
  productBatches: ProductBatch[];
}

// --------------------------------------------------------------------- sales

export interface TodayTakings {
  salesCount: number;
  revenueCents: number;
}

/**
 * `sales.Service.CheckAvailability` surfaced as a read (§4.8), so a draft
 * explains its own refusal before anyone presses anything.
 */
export interface DraftShortfall {
  itemLabel: string;
  wanted: number;
  available: number;
}

export interface SalesDraft {
  saleId: string;
  customerName: string | null;
  lineCount: number;
  shortfalls: DraftShortfall[];
  commands?: WorkCommand[];
}

export interface ConsignmentLocation {
  locationId: string;
  name: string;
  unitsOut: number;
  settlementDueAt: string | null;
  lastSettledAt: string | null;
  commands?: WorkCommand[];
}

export interface SellableItem {
  itemId: string;
  label: string;
  lotCode: string | null;
  /** Home-location availability — what Market Day may actually sell (§4.8). */
  availableAtHome: number;
  commands?: WorkCommand[];
}

/** GET /api/v1/sales/workbench?year= */
export interface SalesWorkbenchResponse extends WorkbenchEnvelope {
  todayTakings: TodayTakings;
  drafts: SalesDraft[];
  consignment: ConsignmentLocation[];
  sellable: SellableItem[];
}

/**
 * A row-level fact that explains, in the server's own numbers, why a command
 * on that row may be refused. It is rendered whether or not the command is
 * actually blocked: an explanation that only appears after the refusal is an
 * error message, and the wave-4 test asks for the explanation *first*.
 */
export interface Explanation {
  kind: "lockout" | "shortfall";
  text: string;
}

/** Locked-out bulk stated as a fact, not as a policy decision (§4.8). */
export function lockoutExplanations(lot: BulkLot): Explanation[] {
  if (!lot.lockedOut) return [];
  const until = lot.lockoutUntil ? ` until ${lot.lockoutUntil.slice(0, 10)}` : "";
  const because = lot.lockoutReason ? ` — ${lot.lockoutReason}` : "";
  return [
    {
      kind: "lockout",
      text: `Lot ${lot.lotCode} is locked out${until}${because}. Bottling and sale of this bulk will be refused.`,
    },
  ];
}

/** A draft's own shortfalls, one line each, in the server's order. */
export function shortfallExplanations(draft: SalesDraft): Explanation[] {
  return (draft.shortfalls ?? []).map((shortfall) => ({
    kind: "shortfall" as const,
    text: `${shortfall.itemLabel}: ${shortfall.wanted} wanted, ${shortfall.available} available at home — short ${
      shortfall.wanted - shortfall.available
    }.`,
  }));
}
