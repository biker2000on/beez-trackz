"use client";

import { useActionState, useRef } from "react";
import { adjustStock } from "@/actions/equipment-v2";
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

interface AdjustStockDialogProps {
  stockId: string;
  typeName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AdjustStockDialog({ stockId, typeName, open, onOpenChange }: AdjustStockDialogProps) {
  const [state, formAction, isPending] = useActionState(adjustStock, null);
  const errorMessage = state && typeof state === "object" && "error" in state
    ? (state as { error: string }).error : null;
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(formRef, (state as { values?: Record<string, string> } | null)?.values);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust Stock: {typeName}</DialogTitle>
        </DialogHeader>
        {errorMessage && <p className="text-destructive text-sm">{errorMessage}</p>}
        <form ref={formRef} action={formAction} className="space-y-4">
          <input type="hidden" name="stockId" value={stockId} />
          <div className="space-y-2">
            <Label>Quantity (positive to add, negative to remove)</Label>
            <Input name="quantity" type="number" required placeholder="e.g. 5 or -2" />
          </div>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Select name="reason" defaultValue="purchased">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="purchased">Purchased</SelectItem>
                <SelectItem value="built">Built</SelectItem>
                <SelectItem value="discarded">Discarded</SelectItem>
                <SelectItem value="broken">Broken</SelectItem>
                <SelectItem value="gifted">Gifted</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Date</Label>
            <Input name="date" type="date" defaultValue={new Date().toISOString().split("T")[0]} />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea name="notes" placeholder="Optional notes..." />
          </div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Save Adjustment"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
