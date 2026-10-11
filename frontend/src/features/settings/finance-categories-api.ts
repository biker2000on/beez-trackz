"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Expense and income categories — the operator's own list
 * (`/finance-categories`, table finance_categories), edited in Operation
 * setup. A category's `key` is the stable slug stored on expenses, imported
 * income and the Folio account mapping; its `label` is what every screen
 * shows. An archived category still labels the rows that carry it but is not
 * offered for new entries.
 */

export type FinanceKind = "expense" | "income";

export interface FinanceCategory {
  id: string;
  kind: FinanceKind;
  key: string;
  label: string;
  sortOrder: number;
  archived: boolean;
  archivedAt: string | null;
  /** Atlas relies on it: renamable, never archived or deleted. */
  isSystem: boolean;
  /** Live expenses or income entries filed under it. */
  usageCount: number;
  /** Nothing (not even a deleted entry) names it, and it is not a system category. */
  deletable: boolean;
}

/** The single editor for the category lists (config registry key). */
export const FINANCE_CATEGORIES_HREF = "/admin/setup#finance-categories";

/**
 * The categories the database starts with, used only when the list cannot
 * be read (a mocked or failed request): every screen still has labels and a
 * sensible list to offer.
 */
const BUILTIN: Record<FinanceKind, Array<[string, string, boolean]>> = {
  expense: [
    ["uncategorized", "Uncategorized", true],
    ["bees_queens", "Bees and queens", true],
    ["feed", "Feed", false],
    ["treatments", "Treatments", false],
    ["packaging", "Packaging", false],
    ["equipment", "Equipment", false],
    ["mileage", "Mileage", false],
    ["market_fees", "Market fees", false],
    ["labor", "Labor", false],
    ["other", "Other", false],
    ["grocery", "Grocery", false],
  ],
  income: [
    ["uncategorized", "Uncategorized", true],
    ["sales_deposit", "Sales deposit", true],
    ["honey_sales", "Honey sales", false],
    ["colony_sales", "Colony sales", false],
    ["product_sales", "Product sales", false],
    ["pollination", "Pollination", false],
    ["services", "Services", false],
    ["grant", "Grant", false],
    ["other", "Other", false],
  ],
};

export function builtinFinanceCategories(kind: FinanceKind): FinanceCategory[] {
  return BUILTIN[kind].map(([key, label, isSystem], index) => ({
    id: `builtin:${kind}:${key}`,
    kind,
    key,
    label,
    sortOrder: index * 10,
    archived: false,
    archivedAt: null,
    isSystem,
    usageCount: 0,
    deletable: false,
  }));
}

/** A readable label for a key no list knows: "market_fees" → "Market fees". */
export function humanizeCategoryKey(key: string): string {
  const words = key.split("_").filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function isCategoryList(value: unknown, kind: FinanceKind): value is FinanceCategory[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        typeof (row as FinanceCategory).key === "string" &&
        typeof (row as FinanceCategory).label === "string" &&
        (row as FinanceCategory).kind === kind,
    )
  );
}

export interface FinanceCategories {
  /** Every category of the kind, archived ones included, in display order. */
  categories: FinanceCategory[];
  /** What a picker offers for a new value: not archived. */
  active: FinanceCategory[];
  /** The label for a key; an unknown key is humanized. */
  label: (key: string) => string;
  byKey: ReadonlyMap<string, FinanceCategory>;
  /** True once the list came from the server (not the built-in fallback). */
  loaded: boolean;
  isPending: boolean;
  isError: boolean;
}

export function financeCategoriesQueryKey(kind: FinanceKind) {
  return ["finance-categories", kind] as const;
}

/**
 * The categories of one kind with their labels. Falls back to the built-in
 * list when the server returns nothing usable, so a label is never missing.
 */
export function useFinanceCategories(kind: FinanceKind): FinanceCategories {
  const query = useQuery({
    queryKey: financeCategoriesQueryKey(kind),
    queryFn: () =>
      api.get<FinanceCategory[]>("/finance-categories", { params: { kind } }),
    staleTime: 60_000,
  });
  const { data, isPending, isError } = query;
  return React.useMemo(() => {
    const loaded = isCategoryList(data, kind);
    const categories = loaded ? data : builtinFinanceCategories(kind);
    const byKey = new Map(categories.map((row) => [row.key, row]));
    return {
      categories,
      active: categories.filter((row) => !row.archived),
      label: (key: string) => byKey.get(key)?.label ?? humanizeCategoryKey(key),
      byKey,
      loaded,
      isPending,
      isError,
    };
  }, [data, isPending, isError, kind]);
}

function useCategoryMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance-categories"] });
      // Pickers and the Folio mapping list categories too.
      queryClient.invalidateQueries({ queryKey: ["folio-imports"] });
      queryClient.invalidateQueries({ queryKey: ["settings", "gnucash"] });
    },
  });
}

export function useCreateFinanceCategory() {
  return useCategoryMutation((body: { kind: FinanceKind; label: string }) =>
    api.post<FinanceCategory>("/finance-categories", body),
  );
}

export function useUpdateFinanceCategory() {
  return useCategoryMutation(
    ({ id, ...body }: { id: string; label?: string; archived?: boolean; sortOrder?: number }) =>
      api.patch<{ success: boolean }>(`/finance-categories/${id}`, body),
  );
}

export function useReorderFinanceCategories() {
  return useCategoryMutation((body: { kind: FinanceKind; ids: string[] }) =>
    api.put<{ success: boolean }>("/finance-categories/order", body),
  );
}

export function useDeleteFinanceCategory() {
  return useCategoryMutation((id: string) =>
    api.delete<{ success: boolean }>(`/finance-categories/${id}`),
  );
}
