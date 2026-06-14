"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";
import { useRef } from "react";
import { deployEquipment } from "@/actions/equipment-v2";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DeployEquipmentDialogProps {
  hiveId: string;
  stock: { id: string; typeName: string; available: number }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeployEquipmentDialog({ hiveId, stock, open, onOpenChange }: DeployEquipmentDialogProps) {
  const [state, formAction, isPending] = useServerActionForm(deployEquipment, null);
  const errorMessage = state && typeof state === "object" && "error" in state
    ? (state as { error: string }).error : null;
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(formRef, (state as { values?: Record<string, string> } | null)?.values);

  const availableStock = stock.filter(s => s.available > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy Equipment to Hive</DialogTitle>
        </DialogHeader>
        {errorMessage && <p className="text-destructive text-sm">{errorMessage}</p>}
        <form ref={formRef} onSubmit={formAction} className="space-y-4">
          <input type="hidden" name="hiveId" value={hiveId} />
          <div className="space-y-2">
            <Label>Equipment Type</Label>
            <Select name="stockId" required>
              <SelectTrigger><SelectValue placeholder="Select equipment" /></SelectTrigger>
              <SelectContent>
                {availableStock.map(s => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.typeName} ({s.available} available)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Quantity</Label>
            <Input name="quantity" type="number" min="1" defaultValue="1" required />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea name="notes" placeholder="Optional notes..." />
          </div>
          <Button type="submit" disabled={isPending || availableStock.length === 0}>
            {isPending ? "Deploying..." : "Deploy"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
