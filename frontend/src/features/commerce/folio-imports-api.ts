"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { FolioImportCounts } from "@/features/settings/api";

/**
 * Entries the Folio history import created (migration 00064): expenses and
 * other income, waiting for a category or for a decision about a change made
 * in Folio. Everything here edits Atlas only — categorizing never writes to
 * Folio.
 */

export interface FolioPending {
  direction: "expense" | "income";
  amountCents: number;
  postDate: string;
  description: string;
  memo: string;
  accountGuids: string[];
}

export interface FolioImportItem {
  id: string;
  bookId: string;
  bookLabel: string;
  bookRetired: boolean;
  transactionGuid: string;
  direction: "expense" | "income";
  entityId: string;
  date: string;
  description: string;
  notes: string | null;
  /**
   * Dollars, signed: a negative expense is a refund (it lowers expenses), a
   * negative income entry is money paid back out (it lowers other income).
   */
  amount: number;
  category: string;
  saleId: string | null;
  saleSummary: string | null;
  state: "remote_changed" | "remote_deleted" | "unrepresentable" | null;
  message: string | null;
  pending: FolioPending | null;
  deleted: boolean;
}

export interface FolioImportList {
  items: FolioImportItem[];
  /** Rows in the view; more than `items.length` when `limit` cut it short. */
  total?: number;
  counts: FolioImportCounts;
  expenseCategories: string[];
  otherIncomeCategories: string[];
}

/**
 * A signed imported amount for display: "−$12.00 refund" for a negative
 * expense, "−$12.00 paid back" for negative income, "+$45.00" for income.
 */
export function formatFolioAmount(
  direction: "expense" | "income",
  amount: number,
  format: (value: number) => string,
): string {
  if (amount < 0) {
    return `−${format(-amount)} ${direction === "expense" ? "refund" : "paid back"}`;
  }
  return direction === "income" ? `+${format(amount)}` : format(amount);
}

/** The bulk Categorize page for imported entries. */
export const CATEGORIZE_HREF = "/sales/expenses/categorize";

/** The Categorize page filtered to deposits not linked to a sale. */
export const UNLINKED_INCOME_HREF = `${CATEGORIZE_HREF}?status=unlinked`;

export interface FolioSaleCandidate {
  id: string;
  date: string;
  orderNumber: string | null;
  customerName: string | null;
  total: number;
  amountPaid: number;
}

/**
 * view "attention" (default): uncategorized and conflicted; "unlinked":
 * imported deposits not linked to an Atlas sale; "all": everything.
 */
export type FolioImportView = "attention" | "unlinked" | "all";

/** The most rows GET /folio-imports returns (folioListMaxLimit). */
export const FOLIO_IMPORTS_MAX_LIMIT = 20000;

export function useFolioImports(
  view: FolioImportView = "attention",
  limit?: number,
) {
  return useQuery({
    queryKey: ["folio-imports", view, limit ?? null],
    queryFn: () =>
      api.get<FolioImportList>("/folio-imports", {
        params: limit ? { view, limit } : { view },
      }),
  });
}

export function useFolioSaleCandidates(id: string | null) {
  return useQuery({
    queryKey: ["folio-imports", "sale-candidates", id],
    queryFn: () =>
      api.get<{ sales: FolioSaleCandidate[] }>(
        `/folio-imports/${id}/sale-candidates`,
      ),
    enabled: id !== null,
  });
}

function useFolioMutation<T>(fn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folio-imports"] });
      queryClient.invalidateQueries({ queryKey: ["commerce"] });
      queryClient.invalidateQueries({ queryKey: ["settings", "gnucash"] });
    },
  });
}

export function useCategorizeFolioImport() {
  return useFolioMutation(({ id, category }: { id: string; category: string }) =>
    api.put(`/folio-imports/${id}/category`, { category }),
  );
}

export function useLinkFolioImportSale() {
  return useFolioMutation(
    ({ id, saleId }: { id: string; saleId: string | null }) =>
      api.put(`/folio-imports/${id}/sale`, { saleId }),
  );
}

export function useAcceptFolioImport() {
  return useFolioMutation((id: string) =>
    api.post(`/folio-imports/${id}/accept`),
  );
}

export function useKeepFolioImport() {
  return useFolioMutation((id: string) => api.post(`/folio-imports/${id}/keep`));
}

/** One id a bulk request refused (400 `rejected`), and why. */
export interface FolioBulkRejection {
  id: string;
  reason: string;
}

/** The per-id refusals carried by a bulk request's 400, if any. */
export function folioBulkRejections(error: unknown): FolioBulkRejection[] {
  const body = (error as { body?: unknown } | null)?.body;
  const rejected = (body as { rejected?: unknown } | null)?.rejected;
  return Array.isArray(rejected) ? (rejected as FolioBulkRejection[]) : [];
}

interface FolioBulkResult {
  success: boolean;
  updated: number;
}

/**
 * Categorize many entries in one all-or-nothing request: expenses (refunds
 * included) or income, never both.
 */
export function useBulkCategorizeFolioImports() {
  return useFolioMutation(
    ({ ids, category }: { ids: string[]; category: string }) =>
      api.put<FolioBulkResult>("/folio-imports/category", { ids, category }),
  );
}

/** "Accept Folio" for many flagged entries, all-or-nothing. */
export function useBulkAcceptFolioImports() {
  return useFolioMutation((ids: string[]) =>
    api.post<FolioBulkResult>("/folio-imports/accept", { ids }),
  );
}

/** "Keep Atlas version" for many flagged entries, all-or-nothing. */
export function useBulkKeepFolioImports() {
  return useFolioMutation((ids: string[]) =>
    api.post<FolioBulkResult>("/folio-imports/keep", { ids }),
  );
}
