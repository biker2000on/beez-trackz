"use client";

/**
 * Harvest session detail (/harvest/sessions/[id]): calculated vs actual
 * extraction summary, per-hive entries, a batch entry editor that saves the
 * whole walkthrough in one operation, and the true-up (finalization) flow
 * with its audit history.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Scale, Trash2, X } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { formatDate, formatLbs, parseNum } from "./format";
import {
  useAddSessionEntries,
  useApiaryOptions,
  useDeleteSessionEntry,
  useHarvestSession,
  useHiveOptions,
  useTrueUpSession,
  useUpdateSession,
  type SessionEntryBody,
} from "./hooks";
import type { HarvestSessionEntry, SessionTrueUp } from "./types";

/** A session with a recorded extracted weight is finalized: the true-up is
 * authoritative and new entries would change nothing. */
export function sessionFinalized(totalExtractedWeight: number | null): boolean {
  return totalExtractedWeight != null && totalExtractedWeight !== 0;
}

export function SessionDetail({ id }: { id: string }) {
  const session = useHarvestSession(id);
  const apiaries = useApiaryOptions();
  const deleteEntry = useDeleteSessionEntry();
  const [confirmEntry, setConfirmEntry] =
    React.useState<HarvestSessionEntry | null>(null);
  const [deleteReason, setDeleteReason] = React.useState("");

  if (session.isPending) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (session.isError) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-4">
        <BackLink />
        <p className="py-8 text-center text-sm text-muted-foreground">
          Could not load this harvest session. It may have been deleted.
        </p>
      </div>
    );
  }

  const data = session.data;
  const finalized = sessionFinalized(data.totalExtractedWeight);
  const apiaryName =
    apiaries.data?.find((apiary) => apiary.id === data.apiaryId)?.name ?? null;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div className="grid gap-1">
        <BackLink />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">
            Harvest session · {formatDate(data.date)}
          </h1>
          <Badge variant={finalized ? "secondary" : "accent"}>
            {finalized ? "Finalized" : "In progress"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {apiaryName ?? "Apiary"}
          {data.notes ? ` — ${data.notes}` : ""}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard
          label="Calculated total"
          value={formatLbs(data.calculatedTotal)}
          sub={`${data.entries.length} hive ${data.entries.length === 1 ? "entry" : "entries"}`}
        />
        <SummaryCard
          label="Actual extracted"
          value={
            data.totalExtractedWeight != null
              ? formatLbs(data.totalExtractedWeight)
              : "—"
          }
          sub={
            finalized
              ? "From true-up — this weight is authoritative"
              : "Record after bottling to finalize"
          }
        />
        <SummaryCard
          label="Difference"
          value={
            data.difference != null
              ? `${data.difference > 0 ? "+" : ""}${formatLbs(data.difference)}`
              : "—"
          }
          sub="Calculated − extracted"
          valueClass={cn(
            data.difference != null && data.difference > 0 && "text-amber-600 dark:text-amber-400",
            data.difference != null && data.difference < 0 && "text-green-700 dark:text-green-400",
          )}
        />
      </div>

      <MoistureCard sessionId={id} moisturePct={data.moisturePct} />

      <Card>
        <CardHeader>
          <CardTitle>Hive entries</CardTitle>
          <CardDescription>
            One row per hive: a super-weight pair (honey = before − after) or a
            directly weighed harvest.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.entries.length === 0 ? (
            <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
              No entries yet. Record the walkthrough below.
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hive</TableHead>
                    <TableHead className="text-right">Super before</TableHead>
                    <TableHead className="text-right">Super after</TableHead>
                    <TableHead className="text-right">Honey</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">
                        {entry.hiveName}
                      </TableCell>
                      {entry.directWeight ? (
                        <TableCell
                          colSpan={2}
                          className="text-right text-xs text-muted-foreground"
                        >
                          Weighed directly
                        </TableCell>
                      ) : (
                        <>
                          <TableCell className="text-right tabular-nums">
                            {formatLbs(entry.superWeightBefore)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatLbs(entry.superWeightAfter)}
                          </TableCell>
                        </>
                      )}
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatLbs(entry.calculatedHoneyWeight)}
                      </TableCell>
                      <TableCell className="max-w-48 truncate text-muted-foreground">
                        {entry.notes ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Remove entry for ${entry.hiveName}`}
                          onClick={() => {
                            setDeleteReason("");
                            setConfirmEntry(entry);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        {finalized ? (
          <Card>
            <CardHeader>
              <CardTitle>Session finalized</CardTitle>
              <CardDescription>
                The trued-up extracted weight is authoritative, so new hive
                entries would not change any total. Adjust the true-up to
                correct the extracted weight.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <AddEntriesCard
            sessionId={id}
            apiaryId={data.apiaryId}
            existingHiveIds={data.entries.map((entry) => entry.hiveId)}
          />
        )}
        <TrueUpCard
          sessionId={id}
          currentWeight={data.totalExtractedWeight}
          calculatedTotal={data.calculatedTotal}
          history={data.trueUpHistory}
        />
      </div>

      <AlertDialog
        open={confirmEntry !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmEntry(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmEntry
                ? `The ${formatLbs(confirmEntry.calculatedHoneyWeight)} entry for ${confirmEntry.hiveName} stops counting toward this session. `
                : ""}
              The record is archived with your reason, not destroyed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="entry-delete-reason">Reason</Label>
            <Input
              id="entry-delete-reason"
              placeholder="e.g. Weighed the wrong hive"
              value={deleteReason}
              onChange={(event) => setDeleteReason(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmEntry) {
                  deleteEntry.mutate({
                    entryId: confirmEntry.id,
                    reason: deleteReason.trim() || undefined,
                  });
                }
                setConfirmEntry(null);
              }}
            >
              Remove entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MoistureCard({
  sessionId,
  moisturePct,
}: {
  sessionId: string;
  moisturePct: number | null;
}) {
  const update = useUpdateSession(sessionId);
  const [edited, setEdited] = React.useState<string | null>(null);
  const value = edited ?? (moisturePct != null ? String(moisturePct) : "");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Refractometer moisture</CardTitle>
        <CardDescription>
          Recorded at extraction. Harvest refuses readings over the instance
          threshold (default 18.6%).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ShortcutForm
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const pct = parseNum(value);
            if (pct == null) return;
            update.mutate({ moisturePct: pct });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="session-moisture">Moisture %</Label>
            <Input
              id="session-moisture"
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              max={100}
              className="w-32"
              value={value}
              onChange={(event) => setEdited(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save moisture"}
          </Button>
        </ShortcutForm>
      </CardContent>
    </Card>
  );
}

function BackLink() {
  return (
    <Link
      href="/harvest/harvests"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Harvests
    </Link>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className={cn("mt-1 text-2xl font-bold tabular-nums", valueClass)}>
          {value}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

// --- batch entry editor ---

type MeasureMode = "supers" | "direct";

interface EntryLine {
  key: number;
  hiveId: string;
  before: string;
  after: string;
  weight: string;
  notes: string;
}

let lineKey = 0;
function emptyLine(): EntryLine {
  lineKey += 1;
  return { key: lineKey, hiveId: "", before: "", after: "", weight: "", notes: "" };
}

function lineHoney(line: EntryLine, mode: MeasureMode): number | null {
  if (mode === "direct") return parseNum(line.weight);
  const before = parseNum(line.before);
  const after = parseNum(line.after);
  return before != null && after != null ? before - after : null;
}

function AddEntriesCard({
  sessionId,
  apiaryId,
  existingHiveIds,
}: {
  sessionId: string;
  apiaryId: string;
  existingHiveIds: string[];
}) {
  const hives = useHiveOptions();
  const mutation = useAddSessionEntries(sessionId);
  const [mode, setMode] = React.useState<MeasureMode>("supers");
  const [lines, setLines] = React.useState<EntryLine[]>(() => [emptyLine()]);
  const [error, setError] = React.useState<string | null>(null);

  // Hives from the session's apiary that don't already have an entry.
  const taken = new Set(existingHiveIds);
  const apiaryHives = (hives.data ?? []).filter(
    (hive) => hive.apiaryId === apiaryId,
  );
  const pool = apiaryHives.length > 0 ? apiaryHives : (hives.data ?? []);
  const chosen = new Set(lines.map((line) => line.hiveId).filter(Boolean));

  const patchLine = (key: number, patch: Partial<EntryLine>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  };

  const filledLines = lines.filter(
    (line) =>
      line.hiveId ||
      line.before.trim() ||
      line.after.trim() ||
      line.weight.trim(),
  );
  const total = filledLines.reduce(
    (sum, line) => sum + (lineHoney(line, mode) ?? 0),
    0,
  );

  const onSave = () => {
    setError(null);
    if (filledLines.length === 0) {
      setError("Add at least one hive entry.");
      return;
    }
    const entries: SessionEntryBody[] = [];
    for (const [index, line] of filledLines.entries()) {
      const name = filledLines.length > 1 ? `Row ${index + 1}: ` : "";
      if (!line.hiveId) {
        setError(`${name}choose a hive.`);
        return;
      }
      if (mode === "direct") {
        const weight = parseNum(line.weight);
        if (weight == null || weight <= 0) {
          setError(`${name}enter the harvested weight.`);
          return;
        }
        entries.push({
          hiveId: line.hiveId,
          harvestedWeight: weight,
          notes: line.notes.trim() || undefined,
        });
        continue;
      }
      const before = parseNum(line.before);
      const after = parseNum(line.after);
      if (before == null || after == null) {
        setError(`${name}enter both super weights.`);
        return;
      }
      if (before - after < 0) {
        setError(`${name}super weight before must be greater than after.`);
        return;
      }
      entries.push({
        hiveId: line.hiveId,
        superWeightBefore: before,
        superWeightAfter: after,
        notes: line.notes.trim() || undefined,
      });
    }
    mutation.mutate(entries, {
      onSuccess: () => setLines([emptyLine()]),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add hive entries</CardTitle>
        <CardDescription>
          Record the whole walkthrough, then save it as one batch.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div
          role="group"
          aria-label="Measurement method"
          className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1"
        >
          <ModeButton
            active={mode === "supers"}
            onClick={() => setMode("supers")}
          >
            Weigh supers
          </ModeButton>
          <ModeButton
            active={mode === "direct"}
            onClick={() => setMode("direct")}
          >
            Direct weight
          </ModeButton>
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === "supers"
            ? "Weigh each hive's supers before and after extraction; honey = before − after."
            : "Weigh the extracted honey itself — buckets on a scale, one weight per hive."}
        </p>

        <div className="grid gap-3">
          {lines.map((line, index) => {
            const honey = lineHoney(line, mode);
            return (
              <div
                key={line.key}
                className="grid gap-2 rounded-lg border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <Select
                    value={line.hiveId}
                    onValueChange={(value) =>
                      patchLine(line.key, { hiveId: value })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={`Hive for row ${index + 1}`}
                    >
                      <SelectValue placeholder="Choose a hive" />
                    </SelectTrigger>
                    <SelectContent>
                      {pool.map((hive) => (
                        <SelectItem
                          key={hive.id}
                          value={hive.id}
                          disabled={
                            (taken.has(hive.id) || chosen.has(hive.id)) &&
                            hive.id !== line.hiveId
                          }
                        >
                          {hive.positionLabel}
                          {taken.has(hive.id) ? " — already entered" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {lines.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove row ${index + 1}`}
                      onClick={() =>
                        setLines((current) =>
                          current.filter((l) => l.key !== line.key),
                        )
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {mode === "supers" ? (
                    <>
                      <div className="grid gap-1">
                        <Label
                          htmlFor={`before-${line.key}`}
                          className="text-xs"
                        >
                          Super weight before (lbs)
                        </Label>
                        <Input
                          id={`before-${line.key}`}
                          type="number"
                          inputMode="decimal"
                          step="0.1"
                          min={0}
                          value={line.before}
                          onChange={(event) =>
                            patchLine(line.key, { before: event.target.value })
                          }
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label
                          htmlFor={`after-${line.key}`}
                          className="text-xs"
                        >
                          Super weight after (lbs)
                        </Label>
                        <Input
                          id={`after-${line.key}`}
                          type="number"
                          inputMode="decimal"
                          step="0.1"
                          min={0}
                          value={line.after}
                          onChange={(event) =>
                            patchLine(line.key, { after: event.target.value })
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <div className="col-span-2 grid gap-1">
                      <Label
                        htmlFor={`weight-${line.key}`}
                        className="text-xs"
                      >
                        Harvested weight (lbs)
                      </Label>
                      <Input
                        id={`weight-${line.key}`}
                        type="number"
                        inputMode="decimal"
                        step="0.1"
                        min={0}
                        value={line.weight}
                        onChange={(event) =>
                          patchLine(line.key, { weight: event.target.value })
                        }
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Input
                    aria-label={`Notes for row ${index + 1}`}
                    placeholder="Notes (optional)"
                    value={line.notes}
                    onChange={(event) =>
                      patchLine(line.key, { notes: event.target.value })
                    }
                  />
                  {honey != null && (
                    <Badge
                      variant={honey < 0 ? "destructive" : "accent"}
                      className="shrink-0 tabular-nums"
                    >
                      {formatLbs(honey)}
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => setLines((current) => [...current, emptyLine()])}
          >
            <Plus />
            Add hive
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending || filledLines.length === 0}
            onClick={onSave}
          >
            {mutation.isPending
              ? "Saving…"
              : `Save ${filledLines.length || ""} ${filledLines.length === 1 ? "entry" : "entries"}`.replace("  ", " ")}
          </Button>
          {filledLines.length > 1 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              Total {formatLbs(total)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// --- true-up ---

function TrueUpCard({
  sessionId,
  currentWeight,
  calculatedTotal,
  history,
}: {
  sessionId: string;
  currentWeight: number | null;
  calculatedTotal: number;
  history: SessionTrueUp[];
}) {
  const mutation = useTrueUpSession(sessionId);
  const [weight, setWeight] = React.useState(
    currentWeight != null ? String(currentWeight) : "",
  );
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Sync the input when a save round-trips a new authoritative weight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWeight(currentWeight != null ? String(currentWeight) : "");
  }, [currentWeight]);

  const entered = parseNum(weight);
  const liveDifference = entered != null ? calculatedTotal - entered : null;

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = parseNum(weight);
    if (value == null || value <= 0) {
      setError("Enter the extracted weight.");
      return;
    }
    setError(null);
    mutation.mutate(
      { totalExtractedWeight: value, reason: reason.trim() || undefined },
      { onSuccess: () => setReason("") },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="size-4 text-primary" />
          True-up
        </CardTitle>
        <CardDescription>
          After bottling, record the actual total extracted. This finalizes
          the session — the trued-up weight becomes authoritative.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ShortcutForm onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="true-up-weight">Total extracted (lbs)</Label>
            <Input
              id="true-up-weight"
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="true-up-reason">Reason</Label>
            <Input
              id="true-up-reason"
              placeholder={
                currentWeight != null
                  ? "Why the correction — kept for the audit trail"
                  : "Optional — e.g. scale recheck after bottling"
              }
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {liveDifference != null && (
            <p className="text-xs text-muted-foreground">
              Difference vs calculated:{" "}
              <span className="font-medium tabular-nums">
                {liveDifference > 0 ? "+" : ""}
                {formatLbs(liveDifference)}
              </span>
            </p>
          )}
          <Button
            type="submit"
            className="justify-self-start"
            disabled={mutation.isPending}
          >
            {mutation.isPending
              ? "Saving…"
              : currentWeight != null
                ? "Update extracted weight"
                : "Finalize session"}
          </Button>
        </ShortcutForm>

        {history.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              True-up history
            </p>
            <ul className="mt-2 grid gap-1.5">
              {history.map((item) => (
                <li key={item.id} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground tabular-nums">
                    {item.previousWeightLbs != null
                      ? `${formatLbs(item.previousWeightLbs)} → `
                      : ""}
                    {formatLbs(item.newWeightLbs)}
                  </span>{" "}
                  · {formatDate(item.recordedAt)}
                  {item.recordedBy ? ` · ${item.recordedBy}` : ""}
                  {item.reason ? ` — ${item.reason}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
