"use client";

/**
 * Stock locations: finished goods that live somewhere other than home.
 *
 * The bike shop sells jars on the operator's behalf and pays as they sell.
 * Handing them stock is a transfer, not a sale — no money moves until they
 * report. These hooks mirror routes_stock_locations.go; every quantity comes
 * from the server's one derivation, never recomputed here.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";

export type StockPriceBasis = "retail" | "commission" | "wholesale_list";

export type StockSettlementCadence =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "on_request";

export interface StockLocation {
  id: string;
  name: string;
  slug: string;
  isHome: boolean;
  isConsignment: boolean;
  customerId: string | null;
  customerName: string | null;
  priceBasis: StockPriceBasis;
  /** Basis points; 3000 is a 30% cut for the shop. */
  commissionBps: number | null;
  wholesalePriceListId: string | null;
  wholesalePriceListName: string | null;
  settlementCadence: StockSettlementCadence;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Units standing here now. Home is the residual of everything else. */
  onHandUnits: number;
  /** Invoiced minus collected: what this location still owes. */
  outstandingBalance: number;
}

export interface StockShelfRow {
  jarSizeId: string | null;
  productId: string | null;
  label: string;
  kind: string;
  unitPrice: number | null;
  onHand: number;
}

export interface StockInventoryRow {
  jarSizeId: string | null;
  productId: string | null;
  label: string;
  kind: string;
  unitPrice: number | null;
  total: number;
  /** Keyed by location id; absent means none of this SKU is there. */
  byLocation: Record<string, number>;
}

export interface StockInventory {
  locations: StockLocation[];
  items: StockInventoryRow[];
}

export interface StockMovement {
  id: string;
  date: string;
  kind: "transfer" | "return" | "adjustment";
  label: string;
  /** Signed against this location: negative left, positive arrived. */
  quantity: number;
  counterpartyName: string | null;
  lotCode: string | null;
  reason: string | null;
  notes: string | null;
  isReversal: boolean;
  reversedByMovementId: string | null;
  settlementId: string | null;
}

export interface StockUnsettledSale {
  id: string;
  date: string;
  orderNumber: string | null;
  orderStatus: string;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
}

export interface StockSettlement {
  id: string;
  locationId: string;
  periodStart: string;
  periodEnd: string;
  reportedAt: string;
  saleId: string | null;
  orderNumber: string | null;
  amountOwed: number;
  amountPaid: number;
  commission: number;
  notes: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface StockLocationDetail {
  location: StockLocation;
  shelf: StockShelfRow[];
  unsettled: StockUnsettledSale[];
  movements: StockMovement[];
  settlements: StockSettlement[];
}

export interface StockStatementLine {
  jarSizeId: string | null;
  productId: string | null;
  label: string;
  kind: string;
  opening: number;
  transferredIn: number;
  transferredOut: number;
  sold: number;
  returned: number;
  shrink: number;
  closing: number;
  revenue: number;
  unitPrice: number | null;
}

export interface StockStatement {
  locationId: string;
  locationName: string;
  priceBasis: StockPriceBasis;
  commissionPercent: number;
  settlementCadence: StockSettlementCadence;
  periodStart: string;
  periodEnd: string;
  lines: StockStatementLine[];
  openingUnits: number;
  transferredInUnits: number;
  soldUnits: number;
  returnedUnits: number;
  shrinkUnits: number;
  closingUnits: number;
  amountInvoiced: number;
  amountCollected: number;
  amountOwed: number;
  commission: number;
}

export interface StockStatementResponse {
  statement: StockStatement;
  /** What is on the shelf right now, which the shop's count is compared to. */
  shelf: StockShelfRow[];
}

export interface StockTransferLineBody {
  jarSizeId?: string;
  productId?: string;
  quantity: number;
  harvestLotId?: string;
  bottlingRunId?: string;
  productBatchId?: string;
}

export interface StockSettlementLineBody {
  jarSizeId?: string;
  productId?: string;
  quantitySold: number;
  quantityReturned: number;
  unitPrice?: number;
  /** Their count of what is left; the difference becomes shrink there. */
  countOnShelf?: number;
}

function useStockMutation<TInput, TResult = unknown>(
  mutationFn: (input: TInput) => Promise<TResult>,
  success: string,
  options: { silentError?: boolean } = {},
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      toast.success(success);
      void client.invalidateQueries({ queryKey: ["stock-locations"] });
      // Moving stock changes what home can sell, so the honey and commerce
      // views have to re-read rather than keep a stale on-hand.
      void client.invalidateQueries({ queryKey: ["honey"] });
      void client.invalidateQueries({ queryKey: ["commerce"] });
      void client.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error) => {
      if (options.silentError) return;
      toast.error(error instanceof Error ? error.message : "Request failed");
    },
  });
}

export function useStockLocations(enabled = true) {
  return useQuery({
    queryKey: ["stock-locations", "list"],
    queryFn: () => api.get<StockLocation[]>("/stock-locations"),
    enabled,
  });
}

export function useStockInventory(enabled = true) {
  return useQuery({
    queryKey: ["stock-locations", "inventory"],
    queryFn: () => api.get<StockInventory>("/stock-locations/inventory"),
    enabled,
  });
}

export function useStockLocationDetail(id: string | null) {
  return useQuery({
    queryKey: ["stock-locations", "detail", id],
    queryFn: () => api.get<StockLocationDetail>(`/stock-locations/${id}`),
    enabled: id != null && id !== "",
  });
}

export function useStockStatement(
  locationId: string | null,
  from: string,
  to: string,
) {
  return useQuery({
    queryKey: ["stock-locations", "statement", locationId, from, to],
    queryFn: () =>
      api.get<StockStatementResponse>(
        `/stock-locations/${locationId}/settlement`,
        { params: { from, to } },
      ),
    enabled: locationId != null && locationId !== "" && from !== "" && to !== "",
  });
}

export function useCreateStockLocation() {
  return useStockMutation(
    (body: {
      name: string;
      isConsignment: boolean;
      customerId?: string;
      priceBasis: StockPriceBasis;
      commissionPercent?: number;
      wholesalePriceListId?: string;
      settlementCadence: StockSettlementCadence;
      address?: string;
      notes?: string;
    }) => api.post<{ id: string; slug: string }>("/stock-locations", body),
    "Location saved",
  );
}

export function useUpdateStockLocation() {
  return useStockMutation(
    ({
      id,
      ...body
    }: {
      id: string;
      name: string;
      isConsignment: boolean;
      customerId?: string | null;
      priceBasis: StockPriceBasis;
      commissionPercent?: number | null;
      wholesalePriceListId?: string | null;
      settlementCadence: StockSettlementCadence;
      address?: string | null;
      notes?: string | null;
      isActive?: boolean;
    }) => api.patch(`/stock-locations/${id}`, body),
    "Location updated",
  );
}

/** Send stock out to a location. Never a sale: no money moves. */
export function useStockTransfer(locationId: string) {
  return useStockMutation(
    (body: {
      date: string;
      fromLocationId?: string;
      lines: StockTransferLineBody[];
      reason?: string;
      notes?: string;
      idempotencyKey?: string;
    }) => api.post(`/stock-locations/${locationId}/transfers`, body),
    "Stock transferred",
    { silentError: true },
  );
}

/** Bring unsold stock home: the reverse transfer. */
export function useStockReturn(locationId: string) {
  return useStockMutation(
    (body: {
      date: string;
      lines: StockTransferLineBody[];
      reason?: string;
      notes?: string;
    }) => api.post(`/stock-locations/${locationId}/returns`, body),
    "Stock returned home",
    { silentError: true },
  );
}

export function useReverseStockMovement() {
  return useStockMutation(
    ({ id, reason }: { id: string; reason?: string }) =>
      api.delete(`/stock-movements/${id}`, reason ? { reason } : undefined),
    "Movement reversed",
  );
}

/** "Record their report": counts sold, returns, and the payment together. */
export function useRecordStockSettlement(locationId: string) {
  return useStockMutation(
    (body: {
      periodStart: string;
      periodEnd: string;
      reportedAt?: string;
      lines: StockSettlementLineBody[];
      amountPaid: number;
      paymentMethod?: string;
      orderNumber?: string;
      notes?: string;
    }) =>
      api.post<{
        id: string;
        saleId: string | null;
        amountOwed: number;
        amountPaid: number;
        balanceDue: number;
        commission: number;
      }>(`/stock-locations/${locationId}/settlements`, body),
    "Report recorded",
    { silentError: true },
  );
}

/**
 * Sell off a location's shelf instead of home's.
 *
 * Home keeps selling through `/sales`; this exists so a second farm stand can
 * ring up its own stock without pretending the jars were at home. Consignment
 * locations refuse it — their revenue is recognised by the report, which takes
 * the counts and the payment together.
 */
export function useStockLocationSale(locationId: string) {
  return useStockMutation(
    (body: {
      date: string;
      channel?: string;
      paymentMethod?: string;
      customerName?: string;
      location?: string;
      discountAmount?: number;
      amountPaid?: number;
      notes?: string;
      lines: {
        jarSizeId?: string;
        productId?: string;
        quantity: number;
        unitPrice: number;
      }[];
    }) => api.post(`/stock-locations/${locationId}/sales`, body),
    "Sale recorded",
    { silentError: true },
  );
}

export function useVoidStockSettlement() {
  return useStockMutation(
    ({ id, reason }: { id: string; reason?: string }) =>
      api.post(`/consignment-settlements/${id}/void`, { reason }),
    "Settlement voided",
  );
}
