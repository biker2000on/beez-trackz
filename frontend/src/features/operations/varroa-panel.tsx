"use client";

import * as React from "react";
import { Activity, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, todayInput } from "@/features/hives/lib";
import { useCreateMiteCount, useVarroaAnalytics } from "./hooks";

const METHOD_LABELS: Record<string, string> = {
  alcohol_wash: "Alcohol wash",
  sugar_roll: "Sugar roll",
  sticky_board: "Sticky board",
  visual: "Visual count",
};

export function VarroaPanel({
  hiveId,
  canEdit = true,
}: {
  hiveId: string;
  canEdit?: boolean;
}) {
  const report = useVarroaAnalytics(hiveId);
  const create = useCreateMiteCount();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(todayInput());
  const [method, setMethod] = React.useState<"alcohol_wash" | "sugar_roll" | "sticky_board" | "visual">("alcohol_wash");
  const [count, setCount] = React.useState("");
  const [sample, setSample] = React.useState("300");
  const [notes, setNotes] = React.useState("");

  function resetDraft() {
    setDate(todayInput());
    setMethod("alcohol_wash");
    setCount("");
    setSample("300");
    setNotes("");
  }

  async function save(resetAfter = false) {
    const mitesCount = Number(count);
    const sampleSize = sample.trim() === "" ? undefined : Number(sample);
    if (!Number.isInteger(mitesCount) || mitesCount < 0 || (sampleSize != null && (!Number.isInteger(sampleSize) || sampleSize <= 0))) {
      toast.error("Enter a non-negative mite count and a positive sample size.");
      return;
    }
    try {
      await create.mutateAsync({
        hiveId,
        date,
        method,
        mitesCount,
        sampleSize,
        notes: notes.trim() || undefined,
      });
      toast.success("Varroa count recorded");
      resetDraft();
      if (!resetAfter) setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save count");
    }
  }

  if (report.isPending) return <Skeleton className="h-48 w-full" />;
  if (report.isError) {
    return <p className="text-sm text-muted-foreground">Could not load Varroa data.</p>;
  }
  const counts = report.data.counts;
  const max = Math.max(1, ...counts.map((row) => row.mitesPer100 ?? row.mitesCount));

  return (
    <div className="grid gap-4">
      {canEdit ? <div className="flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus /> Record mite count
        </Button>
      </div> : null}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" /> Mites per 100 bees
          </CardTitle>
        </CardHeader>
        <CardContent>
          {counts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No structured mite counts yet.</p>
          ) : (
            <div className="flex h-44 items-end gap-2 border-b border-l p-3">
              {counts.map((row) => {
                const value = row.mitesPer100 ?? row.mitesCount;
                return (
                  <div key={row.id} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-[10px] font-medium tabular-nums">{value.toFixed(1)}</span>
                    <div
                      className="w-full max-w-12 rounded-t bg-primary/80"
                      style={{ height: `${Math.max(4, (value / max) * 112)}px` }}
                      title={`${METHOD_LABELS[row.method] ?? row.method}: ${value.toFixed(1)}`}
                    />
                    <span className="truncate text-[9px] text-muted-foreground">
                      {new Date(row.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-3">
        {report.data.treatments.map((treatment) => (
          <Card key={treatment.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div>
                <p className="font-medium">{treatment.product}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(treatment.dateApplied)}
                  {treatment.method ? ` · ${treatment.method}` : ""}
                </p>
              </div>
              <div className="text-right">
                {treatment.efficacyPercent == null ? (
                  <span className="text-xs text-muted-foreground">Needs before/after counts</span>
                ) : (
                  <>
                    <p className="font-semibold tabular-nums">{treatment.efficacyPercent.toFixed(0)}% reduction</p>
                    <p className="text-xs text-muted-foreground">
                      {treatment.beforeMitesPer100?.toFixed(1)} → {treatment.afterMitesPer100?.toFixed(1)}
                    </p>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {canEdit ? <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record Varroa count</DialogTitle></DialogHeader>
          <ShortcutForm
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            onSubmitAndReset={() => save(true)}
            onEscape={() => setOpen(false)}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="mite-date">Date</Label>
                <Input id="mite-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Method</Label>
                <Select value={method} onValueChange={(value) => setMethod(value as typeof method)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(METHOD_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="mite-count">Mites counted</Label>
                <Input id="mite-count" type="number" min="0" step="1" value={count} onChange={(e) => setCount(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mite-sample">Bees sampled</Label>
                <Input id="mite-sample" type="number" min="1" step="1" value={sample} onChange={(e) => setSample(e.target.value)} disabled={method === "sticky_board" || method === "visual"} />
              </div>
            </div>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending}>{create.isPending ? "Saving…" : "Save count"}</Button>
            </DialogFooter>
          </ShortcutForm>
        </DialogContent>
      </Dialog> : null}
    </div>
  );
}
