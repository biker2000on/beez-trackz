"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Link2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/features/honey/format";

import {
  CATEGORIZE_HREF,
  UNLINKED_INCOME_HREF,
  useFolioImports,
} from "./folio-imports-api";

/**
 * "From Folio" on /sales/expenses — a compact summary of what the Folio
 * history import brought in (migration 00064) and still needs a decision:
 * entries to categorize, entries changed or deleted in Folio, and deposits not
 * linked to an Atlas sale. The work itself happens on the Categorize page
 * (`/sales/expenses/categorize`), a selectable grid with bulk actions.
 *
 * Nothing here writes to Folio. Renders nothing until the import has brought
 * something in. An old `?folio=unlinked` link still lands on the unlinked
 * deposits, now on the Categorize page.
 */
export function FolioToCategorize() {
  const searchParams = useSearchParams();
  const imports = useFolioImports("attention");

  if (imports.isPending) return <Skeleton className="h-24 w-full" />;
  if (imports.isError || !imports.data) return null;
  const { items, counts } = imports.data;
  if (counts.imported === 0 && items.length === 0) return null;

  const unlinkedCount = counts.unlinkedIncome ?? 0;
  const unlinkedAmount = counts.unlinkedIncomeAmount ?? 0;
  const attention = imports.data.total ?? items.length;
  const href =
    searchParams.get("folio") === "unlinked" ? UNLINKED_INCOME_HREF : CATEGORIZE_HREF;

  return (
    <Card id="folio-imports">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          From Folio
          <Badge variant={counts.toCategorize > 0 ? "default" : "secondary"}>
            To categorize {counts.toCategorize}
          </Badge>
          {counts.conflicts > 0 ? (
            <Badge variant="destructive">
              Changed in Folio {counts.conflicts}
            </Badge>
          ) : null}
          {unlinkedCount > 0 ? (
            <Badge variant="outline">Not linked to a sale {unlinkedCount}</Badge>
          ) : null}
        </CardTitle>
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin#gnucash">
            Import settings
            <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          {counts.imported} entr{counts.imported === 1 ? "y" : "ies"} imported
          from Folio. Categorizing changes Atlas only; the Folio transaction
          stays where it is. Income linked to an Atlas sale is not counted as
          revenue a second time.
        </p>
        {unlinkedCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
            <span className="flex items-center gap-1">
              <Link2 className="size-3.5 shrink-0 text-warning" />
              {/* One text run: a flex row would drop the spaces between pieces. */}
              <span>
                {`${formatMoney(unlinkedAmount)} of Folio deposits${
                  unlinkedCount === 1 ? " isn't" : ` (${unlinkedCount}) aren't`
                } linked to a sale — link any that are Atlas sales so revenue isn't double counted.`}
              </span>
            </span>
            <Button asChild size="sm" variant="outline">
              <Link href={UNLINKED_INCOME_HREF}>Show unlinked deposits</Link>
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {attention > 0
              ? `${attention} entr${attention === 1 ? "y needs" : "ies need"} a category or a decision.`
              : "Everything imported has a category."}
          </p>
          <Button asChild size="sm" variant={attention > 0 ? "default" : "outline"}>
            <Link href={href}>
              {attention > 0
                ? `Categorize ${attention} entr${attention === 1 ? "y" : "ies"}`
                : "Review imported entries"}
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
