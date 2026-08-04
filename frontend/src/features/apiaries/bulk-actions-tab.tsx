"use client";

import * as React from "react";
import { ClipboardList, Droplets } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  FEEDER_TYPES,
  FEEDING_TYPES,
  QUANTITY_UNITS,
  useBulkFeedings,
} from "@/features/feedings/hooks";
import { useBulkInspections } from "@/features/inspections/hooks";
import { useHives, type Hive } from "@/features/hives/hooks";
import { todayInput } from "@/features/hives/lib";

/** Checkbox list of an apiary's live hives with select-all. */
function HivePicker({
  hives,
  isLoading,
  selected,
  onToggle,
  onSelectAll,
  idPrefix,
}: {
  hives: Hive[];
  isLoading: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: (all: boolean) => void;
  idPrefix: string;
}) {
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (hives.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hives in this apiary yet.
      </p>
    );
  }
  const allSelected = hives.length > 0 && selected.size === hives.length;
  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={allSelected}
          onCheckedChange={(checked) => onSelectAll(checked === true)}
        />
        Select all ({hives.length})
      </label>
      <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
        {hives.map((hive) => (
          <label
            key={hive.id}
            htmlFor={`${idPrefix}-${hive.id}`}
            className="flex items-center gap-2 text-sm"
          >
            <Checkbox
              id={`${idPrefix}-${hive.id}`}
              checked={selected.has(hive.id)}
              onCheckedChange={() => onToggle(hive.id)}
            />
            {hive.positionLabel}
          </label>
        ))}
      </div>
    </div>
  );
}

function useSelection() {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = (hives: Hive[], all: boolean) =>
    setSelected(all ? new Set(hives.map((h) => h.id)) : new Set());
  const clear = () => setSelected(new Set());
  return { selected, toggle, selectAll, clear };
}

export function BulkActionsTab({ apiaryId }: { apiaryId: string }) {
  const hives = useHives({ apiaryId });
  const hiveList = hives.data ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <BulkInspectionCard
        hives={hiveList}
        isLoading={hives.isPending}
      />
      <BulkFeedingCard hives={hiveList} isLoading={hives.isPending} />
    </div>
  );
}

function BulkInspectionCard({
  hives,
  isLoading,
}: {
  hives: Hive[];
  isLoading: boolean;
}) {
  const bulkInspections = useBulkInspections();
  const { selected, toggle, selectAll, clear } = useSelection();
  const [date, setDate] = React.useState(todayInput());
  const [notes, setNotes] = React.useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (selected.size === 0) {
      toast.error("Select at least one hive");
      return;
    }
    try {
      const result = await bulkInspections.mutateAsync({
        hiveIds: Array.from(selected),
        date,
        notes: notes.trim() === "" ? null : notes,
      });
      toast.success(
        `Recorded ${result.count} inspection${result.count === 1 ? "" : "s"}`,
      );
      clear();
      setNotes("");
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not record inspections",
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="size-4 text-primary" />
          Bulk inspection
        </CardTitle>
        <CardDescription>
          Log a quick inspection for several hives at once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <HivePicker
            hives={hives}
            isLoading={isLoading}
            selected={selected}
            onToggle={toggle}
            onSelectAll={(all) => selectAll(hives, all)}
            idPrefix="bulk-inspect"
          />
          <div className="grid gap-2">
            <Label htmlFor="bulk-inspect-date">Date</Label>
            <Input
              id="bulk-inspect-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bulk-inspect-notes">Notes</Label>
            <Textarea
              id="bulk-inspect-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={bulkInspections.isPending || selected.size === 0}
          >
            {bulkInspections.isPending
              ? "Saving…"
              : `Record for ${selected.size} hive${selected.size === 1 ? "" : "s"}`}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function BulkFeedingCard({
  hives,
  isLoading,
}: {
  hives: Hive[];
  isLoading: boolean;
}) {
  const bulkFeedings = useBulkFeedings();
  const { selected, toggle, selectAll, clear } = useSelection();
  const [dateFed, setDateFed] = React.useState(todayInput());
  const [type, setType] = React.useState<string>("sugar_syrup_1to1");
  const [quantity, setQuantity] = React.useState("");
  const [unit, setUnit] = React.useState<string>("quarts");
  const [feederType, setFeederType] = React.useState<string>("none");
  const [notes, setNotes] = React.useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (selected.size === 0) {
      toast.error("Select at least one hive");
      return;
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Quantity must be greater than zero");
      return;
    }
    try {
      const result = await bulkFeedings.mutateAsync({
        hiveIds: Array.from(selected),
        dateFed,
        type,
        quantity: qty,
        quantityUnit: unit,
        feederType: feederType === "none" ? null : feederType,
        notes: notes.trim() === "" ? null : notes,
      });
      toast.success(
        `Recorded ${result.count} feeding${result.count === 1 ? "" : "s"}`,
      );
      clear();
      setQuantity("");
      setNotes("");
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not record feedings",
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Droplets className="size-4 text-primary" />
          Bulk feeding
        </CardTitle>
        <CardDescription>
          Record the same feeding across several hives.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <HivePicker
            hives={hives}
            isLoading={isLoading}
            selected={selected}
            onToggle={toggle}
            onSelectAll={(all) => selectAll(hives, all)}
            idPrefix="bulk-feed"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="bulk-feed-date">Date</Label>
              <Input
                id="bulk-feed-date"
                type="date"
                value={dateFed}
                onChange={(event) => setDateFed(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label>Feed type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEEDING_TYPES.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bulk-feed-qty">Quantity</Label>
              <Input
                id="bulk-feed-qty"
                type="number"
                min="0"
                step="0.1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label>Unit</Label>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUANTITY_UNITS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Feeder type</Label>
            <Select value={feederType} onValueChange={setFeederType}>
              <SelectTrigger>
                <SelectValue placeholder="Optional" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not specified</SelectItem>
                {FEEDER_TYPES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bulk-feed-notes">Notes</Label>
            <Textarea
              id="bulk-feed-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={bulkFeedings.isPending || selected.size === 0}
          >
            {bulkFeedings.isPending
              ? "Saving…"
              : `Feed ${selected.size} hive${selected.size === 1 ? "" : "s"}`}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
