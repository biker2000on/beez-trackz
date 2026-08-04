"use client";

/**
 * The six honey quick actions (jar, sell, use, loss, give away, adjust) and
 * their dialogs, plus the `j s u l v a` shortcuts.
 *
 * The overview shows them as a button row; the section menu shows the same
 * set as a dropdown so recording a sale never means navigating away from a
 * sub-route first. Exactly one instance is mounted at a time, so the
 * shortcuts register once.
 */

import * as React from "react";
import {
  DollarSign,
  Gift,
  Package,
  Plus,
  SlidersHorizontal,
  TriangleAlert,
  Utensils,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useShortcut } from "@/components/shortcuts/provider";

import { useJarInventory } from "./hooks";
import {
  AdjustJarsDialog,
  BulkMovementDialog,
  GiveAwayDialog,
  JarHoneyDialog,
} from "./movement-dialogs";
import { RecordSaleDialog } from "./record-sale-dialog";

type QuickAction = "jar" | "sale" | "use" | "loss" | "give" | "adjust";

const QUICK_ACTIONS: {
  action: QuickAction;
  label: string;
  keyHint: string;
  icon: LucideIcon;
}[] = [
  { action: "jar", label: "Jar honey", keyHint: "j", icon: Package },
  { action: "sale", label: "Record sale", keyHint: "s", icon: DollarSign },
  { action: "use", label: "Bulk use", keyHint: "u", icon: Utensils },
  { action: "loss", label: "Loss", keyHint: "l", icon: TriangleAlert },
  { action: "give", label: "Give away", keyHint: "v", icon: Gift },
  { action: "adjust", label: "Adjust jars", keyHint: "a", icon: SlidersHorizontal },
];

export function HoneyQuickActions({
  variant = "buttons",
}: {
  variant?: "buttons" | "menu";
}) {
  const inventory = useJarInventory();
  const [dialog, setDialog] = React.useState<QuickAction | null>(null);
  const inventoryRows = inventory.data ?? [];

  useShortcut("j", "Jar honey", () => setDialog("jar"));
  useShortcut("s", "Record a sale", () => setDialog("sale"));
  useShortcut("u", "Use bulk honey", () => setDialog("use"));
  useShortcut("l", "Record a loss", () => setDialog("loss"));
  useShortcut("v", "Give away jars", () => setDialog("give"));
  useShortcut("a", "Adjust jar counts", () => setDialog("adjust"));

  function closeDialog(open: boolean) {
    if (!open) setDialog(null);
  }

  return (
    <>
      {variant === "menu" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus />
              Record
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {QUICK_ACTIONS.map(({ action, label, keyHint, icon: Icon }) => (
              <DropdownMenuItem
                key={action}
                onSelect={() => setDialog(action)}
              >
                <Icon className="size-4" />
                {label}
                <kbd className="ml-auto rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                  {keyHint}
                </kbd>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map(({ action, label, keyHint, icon: Icon }) => (
            <Button
              key={action}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDialog(action)}
            >
              <Icon />
              {label}
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                {keyHint}
              </kbd>
            </Button>
          ))}
        </div>
      )}

      <JarHoneyDialog
        open={dialog === "jar"}
        onOpenChange={closeDialog}
        inventory={inventoryRows}
      />
      <RecordSaleDialog
        open={dialog === "sale"}
        onOpenChange={closeDialog}
        inventory={inventoryRows}
      />
      <BulkMovementDialog
        open={dialog === "use"}
        onOpenChange={closeDialog}
        kind="bulk_use"
      />
      <BulkMovementDialog
        open={dialog === "loss"}
        onOpenChange={closeDialog}
        kind="loss"
      />
      <GiveAwayDialog
        open={dialog === "give"}
        onOpenChange={closeDialog}
        inventory={inventoryRows}
      />
      <AdjustJarsDialog
        open={dialog === "adjust"}
        onOpenChange={closeDialog}
        inventory={inventoryRows}
      />
    </>
  );
}
