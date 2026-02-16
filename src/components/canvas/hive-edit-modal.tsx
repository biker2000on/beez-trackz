"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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

interface HiveEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hiveId: string;
  hiveName: string;
  hiveStatus: string;
  hiveNotes?: string;
  onSave: (hiveId: string, data: { positionLabel: string; status: string; notes: string; placement?: string }) => Promise<void>;
}

export function HiveEditModal({
  open,
  onOpenChange,
  hiveId,
  hiveName,
  hiveStatus,
  hiveNotes,
  onSave,
}: HiveEditModalProps) {
  const [positionLabel, setPositionLabel] = useState(hiveName);
  const [status, setStatus] = useState(hiveStatus);
  const [notes, setNotes] = useState(hiveNotes || "");
  const [placement, setPlacement] = useState("full");
  const [isSaving, setIsSaving] = useState(false);
  const router = useRouter();

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(hiveId, { positionLabel, status, notes, placement });
      onOpenChange(false);
      router.refresh();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Hive: {hiveName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Position Label</Label>
            <Input
              value={positionLabel}
              onChange={(e) => setPositionLabel(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Placement</Label>
            <Select value={placement} onValueChange={setPlacement}>
              <SelectTrigger><SelectValue /></SelectTrigger>
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
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="dead">Dead</SelectItem>
                <SelectItem value="sold">Sold</SelectItem>
                <SelectItem value="combined">Combined</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
            />
          </div>
          <Button onClick={handleSave} disabled={isSaving} className="w-full">
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
