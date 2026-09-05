"use client";

import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { ShortcutForm } from "@/components/ui/shortcut-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";

import {
  STAND_LABEL_MAX,
  STAND_MAX_DIM,
  type CanvasHive,
  type HivePlacement,
  type SlotTarget,
  type StandGeometry,
} from "../lib/types";

const DIMENSION_OPTIONS = Array.from({ length: STAND_MAX_DIM }, (_, i) => i + 1);

// ---------------------------------------------------------------------------
// Stand settings (rename ≤4 chars + resize with unassign warning)
// ---------------------------------------------------------------------------

export function StandSettingsDialog({
  stand,
  onOpenChange,
  onSave,
}: {
  stand: StandGeometry;
  onOpenChange: (open: boolean) => void;
  onSave: (label: string, rows: number, cols: number) => void;
}) {
  const [label, setLabel] = useState(stand.label);
  const [rows, setRows] = useState(String(stand.rows));
  const [cols, setCols] = useState(String(stand.cols));

  const shrinking =
    parseInt(rows, 10) < stand.rows || parseInt(cols, 10) < stand.cols;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Stand {stand.label} settings</DialogTitle>
          <DialogDescription>
            Rename the stand or change its slot grid.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(
              label.trim() || stand.label,
              parseInt(rows, 10),
              parseInt(cols, 10),
            );
          }}
          onEscape={() => onOpenChange(false)}
        >
          <div className="space-y-2">
            <Label htmlFor="canvas-stand-label">Label</Label>
            <Input
              id="canvas-stand-label"
              value={label}
              maxLength={STAND_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Rows</Label>
              <Select value={rows} onValueChange={setRows}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIMENSION_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Columns</Label>
              <Select value={cols} onValueChange={setCols}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIMENSION_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p
            className={`text-xs ${shrinking ? "font-medium text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}
          >
            {shrinking
              ? "Shrinking the grid: hives left outside it become unassigned until moved."
              : "Shrinking a stand keeps hive records; hives outside the new grid show as unassigned until moved."}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete stand confirmation
// ---------------------------------------------------------------------------

export function DeleteStandDialog({
  stand,
  hasHives,
  onOpenChange,
  onConfirm,
}: {
  stand: StandGeometry;
  hasHives: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove stand {stand.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {hasHives
              ? "This stand has hives assigned. They will become unassigned (not deleted) and can be placed on another stand."
              : "This stand is empty and will be removed from the layout."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Remove stand</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Hive facing direction (8 compass presets + 0–359 slider)
// ---------------------------------------------------------------------------

const COMPASS_PRESETS = [
  { label: "N", degrees: 0 },
  { label: "NE", degrees: 45 },
  { label: "E", degrees: 90 },
  { label: "SE", degrees: 135 },
  { label: "S", degrees: 180 },
  { label: "SW", degrees: 225 },
  { label: "W", degrees: 270 },
  { label: "NW", degrees: 315 },
];

export function FacingDialog({
  hiveName,
  initialDegrees,
  onOpenChange,
  onSave,
}: {
  hiveName: string;
  initialDegrees: number;
  onOpenChange: (open: boolean) => void;
  onSave: (degrees: number) => void;
}) {
  const [degrees, setDegrees] = useState(
    ((Math.round(initialDegrees) % 360) + 360) % 360,
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Entrance direction — {hiveName}</DialogTitle>
          <DialogDescription>
            Which way does the hive entrance face?
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(degrees);
          }}
          onEscape={() => onOpenChange(false)}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {COMPASS_PRESETS.map((preset) => (
              <Button
                type="button"
                key={preset.label}
                variant={degrees === preset.degrees ? "default" : "outline"}
                size="sm"
                onClick={() => setDegrees(preset.degrees)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="space-y-2">
            <Label>Fine adjust: {degrees}°</Label>
            <Slider
              value={[degrees]}
              min={0}
              max={359}
              step={1}
              onValueChange={([v]) => setDegrees(v)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Move a hive to an empty slot
// ---------------------------------------------------------------------------

const slotKey = (t: SlotTarget) => `${t.standId}:${t.row}:${t.col}`;

export function MoveToSlotDialog({
  hiveName,
  options,
  onOpenChange,
  onMove,
}: {
  hiveName: string;
  options: SlotTarget[];
  onOpenChange: (open: boolean) => void;
  onMove: (target: SlotTarget) => void;
}) {
  const [selected, setSelected] = useState(
    options[0] ? slotKey(options[0]) : "",
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move {hiveName}</DialogTitle>
          <DialogDescription>Pick an empty slot for this hive.</DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const target = options.find((option) => slotKey(option) === selected);
            if (target) onMove(target);
          }}
          onEscape={() => onOpenChange(false)}
        >
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No empty slots available. Add a stand or resize an existing one.
          </p>
        ) : (
          <div className="space-y-2">
            <Label>Destination slot</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a slot" />
              </SelectTrigger>
              <SelectContent>
                {options.map((opt) => (
                  <SelectItem key={slotKey(opt)} value={slotKey(opt)}>
                    {opt.label} (Stand {opt.standLabel})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!selected || options.length === 0}
          >
            Move
          </Button>
        </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Assign an existing hive to a specific empty slot
// ---------------------------------------------------------------------------

export function AssignHiveDialog({
  slotLabel,
  hives,
  onOpenChange,
  onAssign,
}: {
  slotLabel: string;
  /** Candidate hives, unassigned ones first. */
  hives: Array<CanvasHive & { assigned: boolean }>;
  onOpenChange: (open: boolean) => void;
  onAssign: (hiveId: string) => void;
}) {
  const [selected, setSelected] = useState(hives[0]?.id ?? "");

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Assign hive to {slotLabel}</DialogTitle>
          <DialogDescription>
            Move an existing hive into this slot.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected) onAssign(selected);
          }}
          onEscape={() => onOpenChange(false)}
        >
        {hives.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hives available to assign.
          </p>
        ) : (
          <div className="space-y-2">
            <Label>Hive</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a hive" />
              </SelectTrigger>
              <SelectContent>
                {hives.map((hive) => (
                  <SelectItem key={hive.id} value={hive.id}>
                    {hive.positionLabel}
                    {hive.assigned ? " (currently placed)" : " (unassigned)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!selected || hives.length === 0}
          >
            Assign
          </Button>
        </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Stack choice — two hives sharing one slot
// ---------------------------------------------------------------------------

export function StackChoiceDialog({
  onChoice,
}: {
  onChoice: (choice: "top-bottom" | "left-right" | "cancel") => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onChoice("cancel")}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Stack hives</DialogTitle>
          <DialogDescription>
            That slot is occupied. How should the two hives share it?
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <button
            type="button"
            className="w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-secondary"
            onClick={() => onChoice("top-bottom")}
          >
            <div className="text-sm font-medium">Top / Bottom split</div>
            <div className="text-xs text-muted-foreground">Stack vertically</div>
          </button>
          <button
            type="button"
            className="w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-secondary"
            onClick={() => onChoice("left-right")}
          >
            <div className="text-sm font-medium">Left / Right split (nucs)</div>
            <div className="text-xs text-muted-foreground">
              Side-by-side for nuc hives
            </div>
          </button>
          <button
            type="button"
            className="w-full rounded-md px-3 py-2 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary"
            onClick={() => onChoice("cancel")}
          >
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Hive edit (placement seeded from the hive's actual value)
// ---------------------------------------------------------------------------

export function HiveEditDialog({
  hive,
  onOpenChange,
  onSave,
}: {
  hive: CanvasHive;
  onOpenChange: (open: boolean) => void;
  onSave: (data: {
    positionLabel: string;
    status: string;
    notes: string;
    placement: HivePlacement;
  }) => Promise<void>;
}) {
  const [positionLabel, setPositionLabel] = useState(hive.positionLabel);
  const [placement, setPlacement] = useState<HivePlacement>(
    hive.placement ?? "full",
  );
  const [status, setStatus] = useState(hive.status);
  const [notes, setNotes] = useState(hive.notes ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        positionLabel: positionLabel.trim(),
        status,
        notes,
        placement,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit hive — {hive.positionLabel}</DialogTitle>
        </DialogHeader>
        <ShortcutForm
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
          onEscape={() => onOpenChange(false)}
        >
          <div className="space-y-2">
            <Label htmlFor="canvas-hive-label">Position label</Label>
            <Input
              id="canvas-hive-label"
              value={positionLabel}
              onChange={(e) => setPositionLabel(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Placement</Label>
            <Select
              value={placement}
              onValueChange={(v) => setPlacement(v as HivePlacement)}
            >
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
            <Label htmlFor="canvas-hive-notes">Notes</Label>
            <Textarea
              id="canvas-hive-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes…"
            />
          </div>
          <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !positionLabel.trim()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
