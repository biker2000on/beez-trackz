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
import { cn } from "@/lib/utils";
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
  const [conflict, setConflict] = React.useState<MiteCount | null>(null);
  // Touch has no hover: tapping a bar selects it and its actions appear in a
  // full-size row under the chart instead of the hover-only icons per bar.
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
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

  async function save(resetAfter = false, overwrite = false) {
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
        await create.mutateAsync({
          ...payload,
          overwrite: overwrite || undefined,
        });
        toast.success(overwrite ? "Varroa count overwritten" : "Varroa count recorded");
      }
      setConflict(null);
      resetDraft(null);
      if (!resetAfter) setOpen(false);
    } catch (error) {
      if (
        !editing &&
        !overwrite &&
        error instanceof ApiError &&
        error.status === 409
      ) {
        const existing = (error.body as { existing?: MiteCount } | null)?.existing;
        if (existing) {
          setConflict(existing);
          return;
        }
      }
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
  const rawBoards = counts.filter(
    (row) => isBoardMethod(row.method) && row.mitesPerDay == null,
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
            <Activity className="size-4" /> Mite load over time
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <VarroaTrendChart
            counts={counts}
            thresholdPer100={report.data.thresholdPer100}
            thresholdPerDay={report.data.thresholdPerDay}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          {(() => {
            const selected = counts.find((row) => row.id === selectedId);
            if (!selected) return null;
            const display = miteDisplay(selected);
            return (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium tabular-nums">
                    {display?.label ?? `${selected.mitesCount} mites`}
                  </span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {formatDate(selected.date)} · {METHOD_LABELS[selected.method] ?? selected.method}
                    {selected.notes ? ` · ${selected.notes}` : ""}
                  </span>
                </span>
                {canEdit ? (
                  <span className="flex shrink-0 gap-1">
                    <Button type="button" variant="outline" size="sm" onClick={() => openEdit(selected)}>
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setDeleting(selected)}>
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                  </span>
                ) : null}
              </div>
            );
          })()}
        </CardContent>
      </Card>

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
                    <span className="text-xs text-muted-foreground">
                      {treatment.beforeRate != null && treatment.afterRate == null
                        ? "No matching after count"
                        : "Needs before/after counts"}
                    </span>
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
        <AlertDialog open={conflict != null} onOpenChange={(next) => !next && setConflict(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Overwrite this mite count?</AlertDialogTitle>
              <AlertDialogDescription>
                {conflict
                  ? `A ${METHOD_LABELS[conflict.method] ?? conflict.method} already exists for this hive on ${formatDate(conflict.date)} (${miteDisplay(conflict)?.label ?? `${conflict.mitesCount} mites`}). Saving replaces that count.`
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep the existing count</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  void save(false, true);
                }}
                disabled={create.isPending}
              >
                {create.isPending ? "Overwriting…" : "Overwrite"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

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

type TrendSeries = "wash" | "board" | "visual";

const SERIES_META: Record<
  TrendSeries,
  { label: string; className: string; unit: string }
> = {
  wash: { label: "Wash / roll", className: "fill-primary stroke-primary", unit: "/ 100" },
  board: { label: "Sticky board", className: "fill-amber-700 stroke-amber-700 dark:fill-amber-400 dark:stroke-amber-400", unit: "/ day" },
  visual: { label: "Visual", className: "fill-sky-700 stroke-sky-700 dark:fill-sky-400 dark:stroke-sky-400", unit: "/ day" },
};

function trendSeries(row: MiteCount): TrendSeries | null {
  if (isWashMethod(row.method) && row.mitesPer100 != null) return "wash";
  if (row.method === "sticky_board" && row.mitesPerDay != null) return "board";
  if (row.method === "visual" && row.mitesPerDay != null) return "visual";
  return null;
}

function trendValue(row: MiteCount): number | null {
  const series = trendSeries(row);
  if (series === "wash") return row.mitesPer100;
  if (series === "board" || series === "visual") return row.mitesPerDay;
  return null;
}

function VarroaTrendChart({
  counts,
  thresholdPer100,
  thresholdPerDay,
  selectedId,
  onSelect,
}: {
  counts: MiteCount[];
  thresholdPer100: number;
  thresholdPerDay: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const points = counts
    .map((row) => {
      const series = trendSeries(row);
      const value = trendValue(row);
      if (series == null || value == null) return null;
      return { row, series, value, time: new Date(row.date).getTime() };
    })
    .filter((point): point is NonNullable<typeof point> => point != null)
    .sort((a, b) => a.time - b.time);

  if (points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {counts.length === 0
          ? "No structured mite counts yet."
          : "No comparable rates yet. Add a sample size for washes or days on board for sticky boards and visual counts."}
      </p>
    );
  }

  const times = points.map((point) => point.time);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const span = Math.max(maxT - minT, 1);
  const washMax = Math.max(
    1,
    thresholdPer100,
    ...points.filter((p) => p.series === "wash").map((p) => p.value),
  );
  const dayMax = Math.max(
    1,
    thresholdPerDay,
    ...points.filter((p) => p.series !== "wash").map((p) => p.value),
  );
  const hasWash = points.some((p) => p.series === "wash");
  const hasDay = points.some((p) => p.series !== "wash");
  const width = 400;
  const height = 168;
  const pad = { left: 28, right: 28, top: 14, bottom: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  function xOf(time: number): number {
    if (minT === maxT) return pad.left + plotW / 2;
    return pad.left + ((time - minT) / span) * plotW;
  }
  function yOf(value: number, series: TrendSeries): number {
    const max = series === "wash" ? washMax : dayMax;
    return pad.top + plotH - (value / max) * plotH;
  }

  const present = (["wash", "board", "visual"] as const).filter((series) =>
    points.some((p) => p.series === series),
  );

  return (
    <div className="grid gap-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-44 w-full overflow-visible"
        role="img"
        aria-label="Mite counts on a time axis"
      >
        <line
          x1={pad.left}
          y1={pad.top + plotH}
          x2={pad.left + plotW}
          y2={pad.top + plotH}
          className="stroke-border"
          strokeWidth="1"
        />
        <line
          x1={pad.left}
          y1={pad.top}
          x2={pad.left}
          y2={pad.top + plotH}
          className="stroke-border"
          strokeWidth="1"
        />
        {hasWash ? (
          <>
            <line
              x1={pad.left}
              x2={pad.left + plotW}
              y1={yOf(thresholdPer100, "wash")}
              y2={yOf(thresholdPer100, "wash")}
              className="stroke-destructive/70"
              strokeDasharray="4 3"
              strokeWidth="1"
            />
            <text
              x={pad.left + plotW}
              y={yOf(thresholdPer100, "wash") - 4}
              textAnchor="end"
              className="fill-destructive text-[9px]"
            >
              {thresholdPer100.toFixed(1)} / 100
            </text>
          </>
        ) : null}
        {hasDay ? (
          <>
            <line
              x1={pad.left}
              x2={pad.left + plotW}
              y1={yOf(thresholdPerDay, "board")}
              y2={yOf(thresholdPerDay, "board")}
              className="stroke-amber-700/70 dark:stroke-amber-400/70"
              strokeDasharray="2 3"
              strokeWidth="1"
            />
            <text
              x={pad.left}
              y={yOf(thresholdPerDay, "board") - 4}
              className="fill-amber-700 text-[9px] dark:fill-amber-400"
            >
              {thresholdPerDay.toFixed(1)} / day
            </text>
          </>
        ) : null}
        {present.map((series) => {
          const seriesPoints = points.filter((p) => p.series === series);
          if (seriesPoints.length < 2) return null;
          const d = seriesPoints
            .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.time)} ${yOf(p.value, series)}`)
            .join(" ");
          return (
            <path
              key={series}
              d={d}
              fill="none"
              className={SERIES_META[series].className}
              strokeWidth="1.5"
              opacity={0.55}
            />
          );
        })}
        {points.map((point) => {
          const x = xOf(point.time);
          const y = yOf(point.value, point.series);
          const selected = selectedId === point.row.id;
          const label = `${formatDate(point.row.date)} · ${METHOD_LABELS[point.row.method] ?? point.row.method}: ${point.value.toFixed(1)} ${SERIES_META[point.series].unit}`;
          return (
            <g key={point.row.id}>
              <title>{label}</title>
              {point.series === "board" ? (
                <rect
                  x={x - (selected ? 5 : 3.5)}
                  y={y - (selected ? 5 : 3.5)}
                  width={selected ? 10 : 7}
                  height={selected ? 10 : 7}
                  className={cn(SERIES_META.board.className, selected && "stroke-ring")}
                  strokeWidth={selected ? 2 : 1}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={label}
                  onClick={() => onSelect(selected ? null : point.row.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(selected ? null : point.row.id);
                    }
                  }}
                />
              ) : (
                <circle
                  cx={x}
                  cy={y}
                  r={selected ? 6 : point.series === "visual" ? 4.5 : 4}
                  className={cn(
                    SERIES_META[point.series].className,
                    selected && "stroke-ring",
                    point.series === "visual" && "fill-none",
                  )}
                  strokeWidth={selected ? 2 : point.series === "visual" ? 2 : 1}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={label}
                  onClick={() => onSelect(selected ? null : point.row.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(selected ? null : point.row.id);
                    }
                  }}
                />
              )}
            </g>
          );
        })}
        <text
          x={pad.left}
          y={height - 8}
          className="fill-muted-foreground text-[9px]"
        >
          {formatDate(new Date(minT).toISOString())}
        </text>
        <text
          x={pad.left + plotW}
          y={height - 8}
          textAnchor="end"
          className="fill-muted-foreground text-[9px]"
        >
          {formatDate(new Date(maxT).toISOString())}
        </text>
      </svg>
      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        {present.map((series) => (
          <span key={series} className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "size-2 rounded-full",
                series === "wash" && "bg-primary",
                series === "board" && "rounded-sm bg-amber-700 dark:bg-amber-400",
                series === "visual" && "border-2 border-sky-700 bg-transparent dark:border-sky-400",
              )}
            />
            {SERIES_META[series].label} ({SERIES_META[series].unit})
          </span>
        ))}
      </div>
    </div>
  );
}
