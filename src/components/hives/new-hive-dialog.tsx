"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createHive } from "@/actions/hives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useShortcut } from "@/components/keyboard/shortcut-provider";
import { generatePositionLabel } from "@/lib/hive-location";
import { Plus } from "lucide-react";

interface NewHiveDialogProps {
  apiaries: { id: string; name: string }[];
  defaultApiaryId?: string;
  /** Render a smaller trigger (e.g. on the apiary detail page). */
  triggerSize?: "default" | "sm";
}

export function NewHiveDialog({
  apiaries,
  defaultApiaryId,
  triggerSize = "default",
}: NewHiveDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useServerActionForm(createHive, null);
  const result = state as { error?: string; success?: boolean } | null;

  const [apiaryId, setApiaryId] = useState(defaultApiaryId ?? "");
  const [standId, setStandId] = useState("");
  const [slotRow, setSlotRow] = useState("");
  const [slotCol, setSlotCol] = useState("");
  const [placement, setPlacement] = useState("full");
  const [positionLabel, setPositionLabel] = useState("");
  const [status, setStatus] = useState("active");
  const [installedDate, setInstalledDate] = useState("");
  const [notes, setNotes] = useState("");

  useShortcut("n", "New hive", "Hives", () => setOpen(true));

  // Auto-generate the position label from the structured location fields.
  useEffect(() => {
    if (standId || slotRow || slotCol) {
      setPositionLabel(
        generatePositionLabel(
          standId,
          slotRow ? parseInt(slotRow) : null,
          slotCol ? parseInt(slotCol) : null,
          placement
        )
      );
    }
  }, [standId, slotRow, slotCol, placement]);

  const reset = () => {
    setApiaryId(defaultApiaryId ?? "");
    setStandId("");
    setSlotRow("");
    setSlotCol("");
    setPlacement("full");
    setPositionLabel("");
    setStatus("active");
    setInstalledDate("");
    setNotes("");
  };

  useEffect(() => {
    if (result?.success) {
      reset();
      setOpen(false);
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={triggerSize}>
          <Plus className="h-4 w-4 mr-2" />
          New Hive
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Hive</DialogTitle>
        </DialogHeader>
        <form onSubmit={formAction} className="space-y-4">
          {result?.error && (
            <p className="text-destructive text-sm">{result.error}</p>
          )}

          <div className="space-y-2">
            <Label>Apiary *</Label>
            <Select name="apiaryId" value={apiaryId} onValueChange={setApiaryId} required>
              <SelectTrigger>
                <SelectValue placeholder="Select an apiary" />
              </SelectTrigger>
              <SelectContent>
                {apiaries.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Location</Label>
            <div className="flex gap-2">
              <Input
                name="standId"
                placeholder="Stand (e.g. A)"
                className="flex-1"
                value={standId}
                onChange={(e) => setStandId(e.target.value)}
              />
              <Input
                name="slotRow"
                type="number"
                placeholder="Row"
                className="w-20"
                value={slotRow}
                onChange={(e) => setSlotRow(e.target.value)}
              />
              <Input
                name="slotCol"
                type="number"
                placeholder="Col"
                className="w-20"
                value={slotCol}
                onChange={(e) => setSlotCol(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Placement</Label>
              <Select name="placement" value={placement} onValueChange={setPlacement}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full</SelectItem>
                  <SelectItem value="top">Top</SelectItem>
                  <SelectItem value="bottom">Bottom</SelectItem>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select name="status" value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="dead">Dead</SelectItem>
                  <SelectItem value="sold">Sold</SelectItem>
                  <SelectItem value="combined">Combined</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="hive-position">Position Label</Label>
            <Input
              id="hive-position"
              name="positionLabel"
              placeholder="Auto-generated from location, or enter manually"
              value={positionLabel}
              onChange={(e) => setPositionLabel(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="hive-installed">Installed Date</Label>
            <Input
              id="hive-installed"
              name="installedDate"
              type="date"
              value={installedDate}
              onChange={(e) => setInstalledDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="hive-notes">Notes</Label>
            <Textarea
              id="hive-notes"
              name="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : "Create Hive"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
