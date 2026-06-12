"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { removeDeployment } from "@/actions/equipment-v2";
import { Undo2 } from "lucide-react";

export interface DeploymentItem {
  id: string;
  quantity: number;
  dateDeployed: Date;
  dateRemoved: Date | null;
  typeName: string;
  typeCategory: string;
  notes: string | null;
}

// Visual stacking order: covers on top, bottoms at the bottom
const STACK_ORDER: Record<string, number> = {
  cover: 0,
  box: 1,
  frame: 2,
  accessory: 3,
  bottom: 4,
  other: 5,
};

export function EquipmentStack({ deployments }: { deployments: DeploymentItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const active = deployments
    .filter((d) => !d.dateRemoved)
    .sort(
      (a, b) =>
        (STACK_ORDER[a.typeCategory] ?? 9) - (STACK_ORDER[b.typeCategory] ?? 9)
    );

  if (active.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No equipment deployed to this hive. Use Deploy Equipment to add boxes,
        covers, and frames from your inventory.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 max-w-md">
      {active.map((d) => (
        <div
          key={d.id}
          className={
            d.typeCategory === "box"
              ? "flex items-center justify-between rounded-md border px-3 py-3 bg-amber-50/50 dark:bg-amber-950/20"
              : "flex items-center justify-between rounded-md border px-3 py-2"
          }
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium text-sm truncate">{d.typeName}</span>
            {d.quantity > 1 && (
              <Badge variant="secondary" className="shrink-0">
                x {d.quantity}
              </Badge>
            )}
            <Badge variant="outline" className="shrink-0 capitalize font-normal">
              {d.typeCategory}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground shrink-0"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await removeDeployment(d.id);
                router.refresh();
              })
            }
          >
            <Undo2 className="h-3 w-3" />
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}
