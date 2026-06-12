"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StandGeometry } from "@/lib/canvas/types";

// ---------------------------------------------------------------------------
// Stand settings (rename + resize)
// ---------------------------------------------------------------------------

export function StandSettingsDialog({
  stand,
  open,
  onOpenChange,
  onSave,
}: {
  stand: StandGeometry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (standId: string, label: string, rows: number, cols: number) => void;
}) {
  const [label, setLabel] = useState("");
  const [rows, setRows] = useState("1");
  const [cols, setCols] = useState("4");

  useEffect(() => {
    if (stand) {
      setLabel(stand.label);
      setRows(String(stand.rows));
      setCols(String(stand.cols));
    }
  }, [stand]);

  if (!stand) return null;

  const dimensionOptions = [1, 2, 3, 4, 5, 6, 7, 8];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Stand {stand.label} settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="stand-label">Label</Label>
            <Input
              id="stand-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={4}
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
                  {dimensionOptions.map((n) => (
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
                  {dimensionOptions.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Shrinking a stand keeps hive assignments; hives left outside the
            new grid show as unassigned until moved.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(stand.id, label.trim() || stand.label, parseInt(rows), parseInt(cols));
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
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
  open,
  onOpenChange,
  onConfirm,
}: {
  stand: StandGeometry | null;
  hasHives: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (standId: string) => void;
}) {
  if (!stand) return null;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
          <AlertDialogAction onClick={() => onConfirm(stand.id)}>
            Remove stand
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Hive facing direction
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
  open,
  onOpenChange,
  onSave,
}: {
  hiveName: string;
  initialDegrees: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (degrees: number) => void;
}) {
  const [degrees, setDegrees] = useState(initialDegrees);

  useEffect(() => {
    if (open) setDegrees(initialDegrees);
  }, [open, initialDegrees]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Entrance direction — {hiveName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {COMPASS_PRESETS.map((preset) => (
              <Button
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(degrees);
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Move hive to a slot
// ---------------------------------------------------------------------------

export interface SlotOption {
  standId: string;
  standLabel: string;
  standCols: number;
  row: number;
  col: number;
  label: string;
}

export function MoveToSlotDialog({
  hiveName,
  options,
  open,
  onOpenChange,
  onMove,
}: {
  hiveName: string;
  options: SlotOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (option: SlotOption) => void;
}) {
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    if (open) setSelected(options[0] ? optionKey(options[0]) : "");
  }, [open, options]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move {hiveName}</DialogTitle>
        </DialogHeader>
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
                  <SelectItem key={optionKey(opt)} value={optionKey(opt)}>
                    {opt.label} (Stand {opt.standLabel})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected || options.length === 0}
            onClick={() => {
              const option = options.find((o) => optionKey(o) === selected);
              if (option) onMove(option);
              onOpenChange(false);
            }}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function optionKey(opt: SlotOption): string {
  return `${opt.standId}:${opt.row}:${opt.col}`;
}

// ---------------------------------------------------------------------------
// Stack choice (two hives in one slot)
// ---------------------------------------------------------------------------

export function StackChoiceDialog({
  open,
  onOpenChange,
  onChoice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoice: (choice: "top-bottom" | "left-right" | "cancel") => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onChoice("cancel");
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Stack hives</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          How should these hives share the slot?
        </p>
        <div className="space-y-2">
          <button
            className="w-full text-left px-3 py-2 rounded-md border hover:bg-accent transition-colors"
            onClick={() => onChoice("top-bottom")}
          >
            <div className="font-medium text-sm">Top / Bottom split</div>
            <div className="text-xs text-muted-foreground">Stack vertically</div>
          </button>
          <button
            className="w-full text-left px-3 py-2 rounded-md border hover:bg-accent transition-colors"
            onClick={() => onChoice("left-right")}
          >
            <div className="font-medium text-sm">Left / Right split (nucs)</div>
            <div className="text-xs text-muted-foreground">
              Side-by-side for nuc hives
            </div>
          </button>
          <button
            className="w-full text-center px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent transition-colors"
            onClick={() => onChoice("cancel")}
          >
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
