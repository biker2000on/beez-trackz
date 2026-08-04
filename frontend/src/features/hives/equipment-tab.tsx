"use client";

import * as React from "react";
import { PackagePlus, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useDeployEquipment,
  useEquipmentStock,
  useHiveDeployments,
  useRemoveDeployment,
} from "./hooks";
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

function DeployDialog({
  open,
  onOpenChange,
  hiveId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hiveId: string;
}) {
  const stock = useEquipmentStock();
  const deploy = useDeployEquipment();
  const [stockId, setStockId] = React.useState("");
  const [quantity, setQuantity] = React.useState("1");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (open) {
      // Reset draft state each time a fresh deploy workflow begins.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStockId("");
      setQuantity("1");
      setNotes("");
    }
  }, [open]);

  const availableStock = (stock.data ?? []).filter(
    (row) => row.available > 0,
  );
  const selected = availableStock.find((row) => row.id === stockId);
  const max = selected?.available ?? 1;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!stockId) {
      toast.error("Choose equipment to deploy");
      return;
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      toast.error("Quantity must be at least 1");
      return;
    }
    if (qty > max) {
      toast.error(`Only ${max} available`);
      return;
    }
    try {
      await deploy.mutateAsync({
        stockId,
        hiveId,
        quantity: qty,
        notes: notes.trim() === "" ? null : notes,
      });
      toast.success("Equipment deployed");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not deploy equipment",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Deploy equipment</DialogTitle>
          <DialogDescription>
            Move equipment from storage onto this hive.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label>Equipment</Label>
            <Select value={stockId} onValueChange={setStockId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    stock.isPending
                      ? "Loading…"
                      : availableStock.length === 0
                        ? "Nothing available in storage"
                        : "Select equipment"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableStock.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.typeName}
                    {row.frameCondition ? ` (${row.frameCondition})` : ""} —{" "}
                    {row.available} available
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <Badge variant="secondary" className="justify-self-start">
                {selected.available} in storage
              </Badge>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="deploy-qty">Quantity</Label>
            <Input
              id="deploy-qty"
              type="number"
              min="1"
              max={max}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="deploy-notes">Notes</Label>
            <Textarea
              id="deploy-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={deploy.isPending || !stockId}
            >
              {deploy.isPending ? "Deploying…" : "Deploy"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
