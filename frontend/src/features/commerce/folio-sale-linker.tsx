"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatMoney } from "@/features/honey/format";
import { errorMessage } from "@/features/settings/gnucash-format";

import {
  useFolioSaleCandidates,
  useLinkFolioImportSale,
  type FolioImportItem,
} from "./folio-imports-api";

/**
 * Pick the Atlas sale an imported deposit pays for. Linking marks the deposit
 * as that sale's money (and categorizes an uncategorized one as a sales
 * deposit), so the revenue is not counted twice.
 */
export function FolioSaleLinker({
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
        <ul className="grid gap-1" aria-label="Sales near this deposit">
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
