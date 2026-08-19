"use client";

import * as React from "react";
import { Activity, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
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
import { formatDate, todayInput, toDateInput } from "@/features/hives/lib";
import {
  useCreateMiteCount,
  useDeleteMiteCount,
  useUpdateMiteCount,
  useVarroaAnalytics,
  isBoardMethod,
  isWashMethod,
  miteDisplay,
  type MiteCount,
  type MiteMethod,
} from "./hooks";

export const METHOD_LABELS: Record<string, string> = {
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
  const update = useUpdateMiteCount();
  const remove = useDeleteMiteCount();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MiteCount | null>(null);
  const [deleting, setDeleting] = React.useState<MiteCount | null>(null);
  const [date, setDate] = React.useState(todayInput());
  const [method, setMethod] = React.useState<MiteMethod>("alcohol_wash");
  const [count, setCount] = React.useState("");
  const [sample, setSample] = React.useState("300");
  const [daysOnBoard, setDaysOnBoard] = React.useState("1");
  const [notes, setNotes] = React.useState("");

  function resetDraft(next?: MiteCount | null) {
    setEditing(next ?? null);
    setDate(next ? toDateInput(next.date) : todayInput());
    setMethod((next?.method as MiteMethod) ?? "alcohol_wash");
    setCount(next ? String(next.mitesCount) : "");
    setSample(next?.sampleSize != null ? String(next.sampleSize) : "300");
    setDaysOnBoard(next?.daysOnBoard != null ? String(next.daysOnBoard) : "1");
    setNotes(next?.notes ?? "");
  }

  function openCreate() {
    resetDraft(null);
    setOpen(true);
  }

  function openEdit(row: MiteCount) {
    resetDraft(row);
    setOpen(true);
  }

  async function save(resetAfter = false) {
    const mitesCount = Number(count);
    const sampleSize = sample.trim() === "" ? undefined : Number(sample);
    const days = daysOnBoard.trim() === "" ? undefined : Number(daysOnBoard);
    if (!Number.isInteger(mitesCount) || mitesCount < 0) {
      toast.error("Enter a non-negative mite count.");
      return;
    }
    if (
      isWashMethod(method) &&
      (sampleSize == null || !Number.isInteger(sampleSize) || sampleSize <= 0)
    ) {
      toast.error("Enter a positive sample size.");
      return;
    }
    if (
      isBoardMethod(method) &&
      (days == null || !Number.isInteger(days) || days <= 0)
    ) {
      toast.error("Enter how many days the board was on the hive.");
      return;
    }
    try {
      const payload = {
        hiveId,
        date,
        method,
        mitesCount,
        sampleSize: isWashMethod(method) ? sampleSize : undefined,
        daysOnBoard: isBoardMethod(method) ? days : undefined,
        notes: notes.trim() || undefined,
      };
      if (editing) {
        await update.mutateAsync({ id: editing.id, ...payload });
        toast.success("Varroa count updated");
      } else {
        await create.mutateAsync(payload);
        toast.success("Varroa count recorded");
      }
      resetDraft(null);
      if (!resetAfter) setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save count");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await remove.mutateAsync({ id: deleting.id, hiveId });
      toast.success("Varroa count deleted");
      setDeleting(null);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not delete count",
      );
    }
  }

  if (report.isPending) return <Skeleton className="h-48 w-full" />;
  if (report.isError) {
    return (
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">Could not load Varroa data.</p>
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => void report.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const counts = report.data.counts;
  const latest = report.data.latest ?? counts[counts.length - 1] ?? null;
  const latestDisplay = latest ? miteDisplay(latest) : null;
  const threshold = latest
    ? isBoardMethod(latest.method)
      ? report.data.thresholdPerDay
      : report.data.thresholdPer100
    : report.data.thresholdPer100;
  const over = report.data.overThreshold;
  const rateCounts = counts.filter(
    (row) => isWashMethod(row.method) && row.mitesPer100 != null,
  );
  const boardRates = counts.filter(
    (row) => isBoardMethod(row.method) && row.mitesPerDay != null,
  );
  const rawBoards = counts.filter(
    (row) => isBoardMethod(row.method) && row.mitesPerDay == null,
  );
  const chartMax = Math.max(
    1,
    report.data.thresholdPer100,
    ...rateCounts.map((row) => row.mitesPer100 ?? 0),
  );
  const pending = create.isPending || update.isPending;

  return (
    <div className="grid gap-4">
      {canEdit ? <div className="flex justify-end">
        <Button size="sm" onClick={openCreate}>
          <Plus /> Record mite count
        </Button>
      </div> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" /> Latest mite load
          </CardTitle>
        </CardHeader>
        <CardContent>
          {latest == null || latestDisplay == null ? (
            <p className="text-sm text-muted-foreground">
              {counts.length === 0
                ? "No structured mite counts yet."
                : "Latest count has no comparable rate yet. Add days on board for sticky boards."}
            </p>
          ) : (
            <div className="grid gap-1">
              <p
                className={`text-3xl font-semibold tabular-nums ${over ? "text-destructive" : ""}`}
              >
                {latestDisplay.value.toFixed(1)}
                <span className="ml-2 text-base font-medium text-muted-foreground">
                  {latestDisplay.unit}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {METHOD_LABELS[latest.method] ?? latest.method} · {formatDate(latest.date)}
                {over
                  ? ` · ${latestDisplay.value.toFixed(1)} is at or above the ${threshold.toFixed(1)} action level`
                  : ` · action level ${threshold.toFixed(1)}`}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" /> Mites per 100 bees
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rateCounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {counts.length === 0
                ? "No structured mite counts yet."
                : "No alcohol wash or sugar roll counts yet. Board and visual counts are listed separately — they are not a rate per 100 bees."}
            </p>
          ) : (
            <div className="relative flex h-44 items-end gap-2 border-b border-l p-3">
              <div
                aria-hidden
                className="pointer-events-none absolute left-3 right-3 border-t border-dashed border-destructive/70"
                style={{
                  bottom: `${12 + (report.data.thresholdPer100 / chartMax) * 112}px`,
                }}
              />
              <span
                className="pointer-events-none absolute right-3 text-[10px] text-destructive"
                style={{
                  bottom: `${16 + (report.data.thresholdPer100 / chartMax) * 112}px`,
                }}
              >
                {report.data.thresholdPer100.toFixed(1)}
              </span>
              {rateCounts.map((row) => {
                const value = row.mitesPer100 ?? 0;
                return (
                  <div key={row.id} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-[10px] font-medium tabular-nums">{value.toFixed(1)}</span>
                    <div
                      className="w-full max-w-12 rounded-t bg-primary/80"
                      style={{ height: `${Math.max(4, (value / chartMax) * 112)}px` }}
                      title={`${METHOD_LABELS[row.method] ?? row.method}: ${value.toFixed(1)} per 100 bees`}
                    />
                    <span className="truncate text-[9px] text-muted-foreground">
                      {new Date(row.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                    {canEdit ? (
                      <span className="flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit count" onClick={() => openEdit(row)}>
                          <Pencil className="size-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete count" onClick={() => setDeleting(row)}>
                          <Trash2 className="size-3" />
                        </Button>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {boardRates.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mites per day (board / visual)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ul className="grid gap-2">
              {boardRates.map((row) => {
                const display = miteDisplay(row);
                return (
                  <li key={row.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-medium tabular-nums">
                        {display?.label ?? `${row.mitesCount} mites`}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(row.date)}
                        {row.daysOnBoard != null ? ` · ${row.daysOnBoard}d on board` : ""}
                        {row.notes ? ` · ${row.notes}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="text-xs text-muted-foreground">
                        {METHOD_LABELS[row.method] ?? row.method}
                      </span>
                      {canEdit ? (
                        <>
                          <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit count" onClick={() => openEdit(row)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete count" onClick={() => setDeleting(row)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {rawBoards.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Board drop and visual counts</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              These counts have no days-on-board, so they cannot be shown as a
              mites-per-day rate. Edit them to add exposure duration.
            </p>
            <ul className="grid gap-2">
              {rawBoards.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {row.method === "sticky_board"
                        ? `${row.mitesCount} mites (board drop)`
                        : `${row.mitesCount} mites (visual)`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(row.date)}
                      {row.notes ? ` · ${row.notes}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-xs text-muted-foreground">
                      {METHOD_LABELS[row.method] ?? row.method}
                    </span>
                    {canEdit ? (
                      <>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit count" onClick={() => openEdit(row)}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete count" onClick={() => setDeleting(row)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3">
        {report.data.treatments.map((treatment) => {
          const before = treatment.beforeRate ?? treatment.beforeMitesPer100;
          const after = treatment.afterRate ?? treatment.afterMitesPer100;
          const unit =
            treatment.beforeRateKind === "per_day" ||
            treatment.afterRateKind === "per_day"
              ? "/ day"
              : "/ 100";
          return (
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
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {before?.toFixed(1)} → {after?.toFixed(1)} {unit}
                      </p>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {canEdit ? <Dialog open={open} onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetDraft(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Varroa count" : "Record Varroa count"}</DialogTitle>
          </DialogHeader>
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
              {isWashMethod(method) ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="mite-sample">Bees sampled</Label>
                  <Input id="mite-sample" type="number" min="1" step="1" value={sample} onChange={(e) => setSample(e.target.value)} />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="mite-days">Days on board</Label>
                  <Input id="mite-days" type="number" min="1" step="1" value={daysOnBoard} onChange={(e) => setDaysOnBoard(e.target.value)} />
                </div>
              )}
            </div>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={pending}>{pending ? "Saving…" : editing ? "Save changes" : "Save count"}</Button>
            </DialogFooter>
          </ShortcutForm>
        </DialogContent>
      </Dialog> : null}

      {canEdit ? (
        <AlertDialog open={deleting != null} onOpenChange={(next) => !next && setDeleting(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this mite count?</AlertDialogTitle>
              <AlertDialogDescription>
                {deleting
                  ? `${METHOD_LABELS[deleting.method] ?? deleting.method} from ${formatDate(deleting.date)} will be removed.`
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={(event) => {
                  event.preventDefault();
                  void confirmDelete();
                }}
                disabled={remove.isPending}
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
