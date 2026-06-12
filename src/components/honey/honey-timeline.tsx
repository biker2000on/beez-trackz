"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { deleteMovement, deleteSale, type TimelineEntry } from "@/actions/honey";
import {
  Package,
  DollarSign,
  FlaskConical,
  Trash2,
  Gift,
  SlidersHorizontal,
  X,
} from "lucide-react";

const TYPE_META: Record<
  TimelineEntry["type"],
  { icon: typeof Package; tint: string }
> = {
  jarring: { icon: Package, tint: "text-amber-600 bg-amber-50 dark:bg-amber-950" },
  sale: { icon: DollarSign, tint: "text-green-600 bg-green-50 dark:bg-green-950" },
  bulk_use: { icon: FlaskConical, tint: "text-blue-600 bg-blue-50 dark:bg-blue-950" },
  loss: { icon: Trash2, tint: "text-red-600 bg-red-50 dark:bg-red-950" },
  give_away: { icon: Gift, tint: "text-purple-600 bg-purple-50 dark:bg-purple-950" },
  jar_adjustment: {
    icon: SlidersHorizontal,
    tint: "text-stone-600 bg-stone-100 dark:bg-stone-900",
  },
};

export function HoneyTimeline({ entries }: { entries: TimelineEntry[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No activity yet. Use the buttons above to jar honey, record a sale, or
        log bulk use.
      </p>
    );
  }

  const remove = (entry: TimelineEntry) => {
    startTransition(async () => {
      if (entry.type === "sale") await deleteSale(entry.id);
      else await deleteMovement(entry.id);
      router.refresh();
    });
  };

  return (
    <ul className="divide-y">
      {entries.map((entry) => {
        const meta = TYPE_META[entry.type];
        const Icon = meta.icon;
        return (
          <li key={`${entry.type}-${entry.id}`} className="flex items-center gap-3 py-2.5">
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${meta.tint}`}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm truncate">{entry.description}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(entry.date).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                {entry.notes ? ` · ${entry.notes}` : ""}
              </p>
            </div>
            {entry.totalAmount != null && (
              <span className="text-sm font-semibold tabular-nums shrink-0">
                ${entry.totalAmount.toFixed(2)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              disabled={pending}
              onClick={() => remove(entry)}
              aria-label="Delete entry"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
