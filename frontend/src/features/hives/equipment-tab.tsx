"use client";

import * as React from "react";
import { PackagePlus, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
// The shared dialog covers both directions (stock fixed → pick hive, hive
// fixed → pick stock); this tab used to carry its own copy.
import { DeployDialog } from "@/features/equipment/stock-dialogs";
import { useHiveDeployments, useRemoveDeployment } from "./hooks";
import { formatDate } from "./lib";

export function EquipmentTab({
  hiveId,
  canManage = true,
}: {
  hiveId: string;
  canManage?: boolean;
}) {
  const deployments = useHiveDeployments(hiveId);
  const removeDeployment = useRemoveDeployment();
  const [deployOpen, setDeployOpen] = React.useState(false);

  const list = deployments.data ?? [];
  const active = list.filter((d) => !d.dateRemoved);
  const removed = list.filter((d) => d.dateRemoved);

  async function onReturn(id: string) {
    try {
      await removeDeployment.mutateAsync(id);
      toast.success("Returned to storage");
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not return the equipment",
      );
    }
  }

  return (
    <div className="grid gap-4">
      {canManage ? <div className="flex justify-end">
        <Button size="sm" onClick={() => setDeployOpen(true)}>
          <PackagePlus className="size-4" />
          Deploy equipment
        </Button>
      </div> : null}

      {deployments.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No equipment deployed to this hive yet.
        </p>
      ) : (
        <div className="grid gap-4">
          {active.length > 0 && (
            <ul className="grid gap-2">
              {active.map((deployment) => (
                <li
                  key={deployment.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {deployment.outstanding ?? deployment.quantity}×{" "}
                      {deployment.typeName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Since {formatDate(deployment.dateDeployed)}
                      {deployment.outstanding != null &&
                        deployment.outstanding < deployment.quantity &&
                        ` · ${deployment.quantity - deployment.outstanding} of ${deployment.quantity} returned`}
                      {deployment.notes && ` · ${deployment.notes}`}
                    </p>
                  </div>
                  {canManage ? <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onReturn(deployment.id)}
                    disabled={removeDeployment.isPending}
                  >
                    <Undo2 className="size-4" />
                    Return to storage
                  </Button> : null}
                </li>
              ))}
            </ul>
          )}
          {removed.length > 0 && (
            <div className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Previously deployed
              </h3>
              <ul className="grid gap-1.5">
                {removed.map((deployment) => (
                  <li
                    key={deployment.id}
                    className="flex items-center justify-between gap-2 text-sm text-muted-foreground"
                  >
                    <span>
                      {deployment.quantity}× {deployment.typeName}
                    </span>
                    <span className="text-xs">
                      {formatDate(deployment.dateDeployed)} –{" "}
                      {formatDate(deployment.dateRemoved)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {canManage ? <DeployDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        hiveId={hiveId}
      /> : null}
    </div>
  );
}
