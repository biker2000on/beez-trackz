"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Pencil, Trash2 } from "lucide-react";
import { updateHive, deleteHive } from "@/actions/hives";

interface HiveEditModalProps {
  hiveId: string;
  defaultValues: {
    positionLabel?: string | null;
    standId?: string | null;
    slotRow?: number | null;
    slotCol?: number | null;
    placement?: string | null;
    status?: string | null;
    installedDate?: Date | null;
    notes?: string | null;
  };
}

export function HiveEditModal({ hiveId, defaultValues }: HiveEditModalProps) {
  const [open, setOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const router = useRouter();

  // Form state
  const [standId, setStandId] = useState(defaultValues?.standId ?? "");
  const [slotRow, setSlotRow] = useState(defaultValues?.slotRow?.toString() ?? "");
  const [slotCol, setSlotCol] = useState(defaultValues?.slotCol?.toString() ?? "");
  const [placement, setPlacement] = useState(defaultValues?.placement ?? "full");
  const [positionLabel, setPositionLabel] = useState(defaultValues?.positionLabel ?? "");
  const [status, setStatus] = useState(defaultValues?.status ?? "active");
  const [notes, setNotes] = useState(defaultValues?.notes ?? "");
  const [installedDate, setInstalledDate] = useState(
    defaultValues?.installedDate ? new Date(defaultValues.installedDate).toISOString().split("T")[0] : ""
  );
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPending(true);
    setError(null);

    const formData = new FormData();
    formData.set("positionLabel", positionLabel);
    formData.set("standId", standId);
    formData.set("slotRow", slotRow);
    formData.set("slotCol", slotCol);
    formData.set("placement", placement);
    formData.set("status", status);
    formData.set("notes", notes);
    formData.set("installedDate", installedDate);

    try {
      const result = await updateHive(hiveId, null, formData);
      if (result && typeof result === "object" && "error" in result) {
        setError((result as { error: string }).error);
      } else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError("Failed to update hive");
    } finally {
      setIsPending(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteHive(hiveId);
      // deleteHive redirects, so this may not execute
      router.push("/hives");
    } catch {
      setError("Failed to delete hive");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="h-4 w-4 mr-2" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Hive</DialogTitle>
        </DialogHeader>

        {error && (
          <p className="text-destructive text-sm">{error}</p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Location */}
          <div className="space-y-2">
            <Label>Location</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Stand"
                value={standId}
                onChange={(e) => setStandId(e.target.value)}
                className="flex-1"
              />
              <Input
                type="number"
                placeholder="Row"
                value={slotRow}
                onChange={(e) => setSlotRow(e.target.value)}
                className="w-24"
              />
              <Input
                type="number"
                placeholder="Col"
                value={slotCol}
                onChange={(e) => setSlotCol(e.target.value)}
                className="w-24"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Placement</Label>
            <Select value={placement} onValueChange={setPlacement}>
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
            <Label>Position Label</Label>
            <Input
              value={positionLabel}
              onChange={(e) => setPositionLabel(e.target.value)}
              placeholder="Auto-generated or manual"
            />
          </div>

          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
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

          <div className="space-y-2">
            <Label>Installed Date</Label>
            <Input
              type="date"
              value={installedDate}
              onChange={(e) => setInstalledDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between pt-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="destructive" size="sm">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Hive
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Hive Permanently?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete this hive and all associated data. This action cannot be undone. Consider archiving instead if you want to keep the history.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Delete Permanently
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
