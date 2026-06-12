"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { deleteMovement, deleteSale, type TimelineEntry } from "@/actions/honey";
import { useBulkSelection } from "@/components/bulk/use-bulk-selection";
import { BulkActionBar } from "@/components/bulk/bulk-action-bar";
import { useShortcut } from "@/components/keyboard/shortcut-provider";
import {
  Package,
  DollarSign,
  FlaskConical,
  Trash2,
  Gift,
  SlidersHorizontal,
  X,
  ListChecks,
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
  const selection = useBulkSelection();

  useShortcut("b", "Toggle bulk selection", "Honey", selection.toggleSelecting);

  const entryKey = (e: TimelineEntry) => `${e.type}:${e.id}`;

  const removeSelected = () => {
    const keys = selection.selected;
    const targets = entries.filter((e) => keys.has(entryKey(e)));
    startTransition(async () => {
      for (const entry of targets) {
        if (entry.type === "sale") await deleteSale(entry.id);
        else await deleteMovement(entry.id);
      }
      selection.clear();
      router.refresh();
    });
  };

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
    <div>
      <div className="flex justify-end mb-1">
        <Button
          variant={selection.selecting ? "default" : "ghost"}
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={selection.toggleSelecting}
          title="Toggle bulk selection (b)"
        >
          <ListChecks className="h-3.5 w-3.5" />
          Select
        </Button>
      </div>
    <ul className="divide-y">
      {entries.map((entry) => {
        const meta = TYPE_META[entry.type];
        const Icon = meta.icon;
        return (
          <li key={`${entry.type}-${entry.id}`} className="flex items-center gap-3 py-2.5">
            {selection.selecting && (
              <Checkbox
                checked={selection.selected.has(entryKey(entry))}
                onCheckedChange={() => selection.toggle(entryKey(entry))}
                aria-label="Select entry"
              />
            )}
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
      <BulkActionBar count={selection.selected.size} onClear={selection.clear}>
        <Button
          variant="destructive"
          size="sm"
          className="h-8 gap-1.5"
          disabled={pending}
          onClick={removeSelected}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete entries
        </Button>
      </BulkActionBar>
    </div>
  );
}
