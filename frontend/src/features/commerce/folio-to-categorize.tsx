"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Link2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatMoney } from "@/features/honey/format";
import { errorMessage, humanize } from "@/features/settings/gnucash-format";

import {
  useAcceptFolioImport,
  useCategorizeFolioImport,
  useFolioImports,
  useFolioSaleCandidates,
  useKeepFolioImport,
  useLinkFolioImportSale,
  type FolioImportItem,
} from "./folio-imports-api";

/**
 * "To categorize" — what the Folio history import brought in and still needs
 * a decision (migration 00064). Imported expenses arrive as
 * "uncategorized" and imported income as uncategorized other income; the
 * operator picks a category here, links a deposit to the Atlas sale it pays
 * for, and settles anything Folio changed or deleted since.
 *
 * Nothing here writes to Folio: the transaction stays where the bookkeeper
 * put it. Renders nothing until the import has brought something in.
 */
export function FolioToCategorize() {
  const imports = useFolioImports("attention");
  const categorize = useCategorizeFolioImport();
  const accept = useAcceptFolioImport();
  const keep = useKeepFolioImport();
  const [linking, setLinking] = React.useState<string | null>(null);

  if (imports.isPending) return <Skeleton className="h-24 w-full" />;
  if (imports.isError || !imports.data) return null;
  const { items, counts, expenseCategories, otherIncomeCategories } =
    imports.data;
  if (counts.imported === 0 && items.length === 0) return null;

  const busy = categorize.isPending || accept.isPending || keep.isPending;
  const onError = (fallback: string) => (error: unknown) =>
    toast.error(errorMessage(error, fallback));

  return (
    <Card>
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
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Everything imported has a category.
          </p>
        ) : (
          <ul className="grid gap-2">
            {items.map((item) => (
              <FolioImportRow
                key={item.id}
                item={item}
                categories={
                  item.direction === "expense"
                    ? expenseCategories
                    : otherIncomeCategories.filter(
                        (value) => value !== "uncategorized",
                      )
                }
                busy={busy}
                linking={linking === item.id}
                onToggleLink={() =>
                  setLinking((current) => (current === item.id ? null : item.id))
                }
                onCategorize={(category) =>
                  categorize.mutate(
                    { id: item.id, category },
                    {
                      onSuccess: () =>
                        toast.success(`Categorized as ${humanize(category)}`),
                      onError: onError("Could not save the category"),
                    },
                  )
                }
                onAccept={() =>
                  accept.mutate(item.id, {
                    onSuccess: () => toast.success("Applied the Folio version"),
                    onError: onError("Could not apply the Folio version"),
                  })
                }
                onKeep={() =>
                  keep.mutate(item.id, {
                    onSuccess: () => toast.success("Kept the Atlas entry"),
                    onError: onError("Could not dismiss"),
                  })
                }
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FolioImportRow({
  item,
  categories,
  busy,
  linking,
  onToggleLink,
  onCategorize,
  onAccept,
  onKeep,
}: {
  item: FolioImportItem;
  categories: string[];
  busy: boolean;
  linking: boolean;
  onToggleLink: () => void;
  onCategorize: (category: string) => void;
  onAccept: () => void;
  onKeep: () => void;
}) {
  const income = item.direction === "income";
  return (
    <li className="grid gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="grid min-w-0 gap-0.5">
          <span className="font-medium">{item.description}</span>
          <span className="text-xs text-muted-foreground">
            {formatDate(item.date)} · {income ? "Money in" : "Money out"} ·{" "}
            {item.bookLabel}
            {item.bookRetired ? " (retired book)" : ""}
            {item.notes ? ` · ${item.notes}` : ""}
          </span>
        </div>
        <span
          className={
            income
              ? "font-medium tabular-nums text-success"
              : "font-medium tabular-nums"
          }
        >
          {income ? "+" : ""}
          {formatMoney(item.amount)}
        </span>
      </div>

      {item.state ? (
        <div className="grid gap-2 rounded-md border border-warning/40 bg-warning/5 p-2">
          <p className="flex items-center gap-1 text-xs">
            <AlertTriangle className="size-3.5 shrink-0 text-warning" />
            {item.message}
          </p>
          {item.pending ? (
            <p className="text-xs text-muted-foreground">
              Folio now says: {item.pending.description} ·{" "}
              {formatDate(item.pending.postDate)} ·{" "}
              {item.pending.direction === "income" ? "money in" : "money out"}{" "}
              {formatMoney(item.pending.amountCents / 100)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {item.state !== "unrepresentable" ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={onAccept}>
                {item.state === "remote_deleted"
                  ? "Remove from Atlas"
                  : "Use the Folio version"}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy} onClick={onKeep}>
              Keep the Atlas entry
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={item.category === "uncategorized" ? "" : item.category}
          onValueChange={onCategorize}
          disabled={busy || item.deleted}
        >
          <SelectTrigger
            className="h-8 w-56"
            aria-label={`Category for ${item.description}`}
          >
            <SelectValue placeholder="Choose a category" />
          </SelectTrigger>
          <SelectContent>
            {categories.map((value) => (
              <SelectItem key={value} value={value}>
                {humanize(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {income ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || item.deleted}
            onClick={onToggleLink}
          >
            <Link2 />
            {item.saleSummary ? `Sale ${item.saleSummary}` : "This is a sale…"}
          </Button>
        ) : null}
      </div>
      {income && linking ? <SaleLinker item={item} onDone={onToggleLink} /> : null}
    </li>
  );
}

/** Pick the Atlas sale an imported deposit pays for. */
function SaleLinker({
  item,
  onDone,
}: {
  item: FolioImportItem;
  onDone: () => void;
}) {
  const candidates = useFolioSaleCandidates(item.id);
  const link = useLinkFolioImportSale();
  if (candidates.isPending) return <Skeleton className="h-16 w-full" />;
  const sales = candidates.data?.sales ?? [];
  const choose = (saleId: string | null) =>
    link.mutate(
      { id: item.id, saleId },
      {
        onSuccess: () => {
          toast.success(saleId ? "Linked to the sale" : "Unlinked");
          onDone();
        },
        onError: (error) =>
          toast.error(errorMessage(error, "Could not link the sale")),
      },
    );
  return (
    <div className="grid gap-1 rounded-md bg-muted/40 p-2">
      <p className="text-xs text-muted-foreground">
        Sales around {formatDate(item.date)}, closest amount first. Linking
        marks this deposit as that sale&apos;s money, so it is not counted as
        income twice.
      </p>
      {sales.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sales near this date.</p>
      ) : (
        <ul className="grid gap-1">
          {sales.map((sale) => (
            <li key={sale.id}>
              <button
                type="button"
                disabled={link.isPending}
                className="flex w-full flex-wrap justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted"
                onClick={() => choose(sale.id)}
              >
                <span>
                  {formatDate(sale.date)} ·{" "}
                  {[sale.orderNumber, sale.customerName].filter(Boolean).join(" — ") ||
                    "Sale"}
                </span>
                <span className="tabular-nums">
                  paid {formatMoney(sale.amountPaid)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {item.saleId ? (
        <div>
          <Button size="sm" variant="ghost" onClick={() => choose(null)}>
            Unlink the sale
          </Button>
        </div>
      ) : null}
    </div>
  );
}
