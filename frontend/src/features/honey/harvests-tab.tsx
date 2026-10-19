"use client";

/**
 * Harvests page: harvest sessions and the per-hive harvests recorded outside
 * one. One entry point, "Record harvest", opens a dialog that asks what is
 * being recorded — an extraction day at an apiary (a session) or one hive on
 * its own (with a live calculated weight = before − after).
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createColumnHelper,
  useTable,
} from "@tanstack/react-table";
import { ChevronRight, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

import { ApiError } from "@/lib/api";
import { useUnits } from "@/lib/use-units";

import { formatDate, parseHoneyWeight, parseNum, todayISO } from "./format";
import {
  useApiaryOptions,
  useCreateHarvest,
  useCreateSession,
  useHarvests,
  useHarvestSessions,
  useHiveOptions,
} from "./hooks";
import {
  SESSION_STATUS_LABELS,
  SessionStatusBadge,
  sessionStatus,
} from "./session-status";
import type { HarvestRow, HarvestSessionRow } from "./types";

const gridFeatures = dataGridFeatures;
const columnHelper = createColumnHelper<
  typeof gridFeatures,
  HarvestSessionRow
>();
const harvestColumnHelper = createColumnHelper<typeof gridFeatures, HarvestRow>();

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

function HarvestLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid justify-items-center gap-3 py-4 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/stock">Open Stock</Link>
        </Button>
        <Button type="button" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export function HarvestsTab() {
  const router = useRouter();
  const { formatHoney } = useUnits();
  const sessions = useHarvestSessions();
  const harvests = useHarvests();
  const [recordOpen, setRecordOpen] = React.useState(false);

  // Session entries live on their session's page; listing them here as well
  // double-counted every entry with no marker of where it belonged.
  const standalone = React.useMemo(
    () => (harvests.data ?? []).filter((harvest) => !harvest.sessionId),
    [harvests.data],
  );

  const harvestColumns = React.useMemo(
    () =>
      harvestColumnHelper.columns([
        harvestColumnHelper.accessor((h) => h.date, {
          id: "date",
          header: "Date",
          meta: { card: "subtitle" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => formatDate(getValue()),
        }),
        harvestColumnHelper.accessor((h) => h.hiveName, {
          id: "hive",
          header: "Hive",
          meta: { card: "title", cellClassName: "font-medium" } satisfies DataGridColumnMeta,
        }),
        harvestColumnHelper.accessor((h) => h.apiaryName, {
          id: "apiary",
          header: "Apiary",
          meta: {
            cellClassName: "text-muted-foreground",
            filter: true,
            filterAllLabel: "All apiaries",
          } satisfies DataGridColumnMeta,
        }),
        harvestColumnHelper.accessor(
          (h) => (h.directWeight ? undefined : h.superWeightBefore),
          {
            id: "before",
            header: "Super before",
            sortUndefined: "last",
            meta: rightAligned,
            cell: ({ row: { original: h } }) =>
              h.directWeight ? (
                <span className="text-xs text-muted-foreground">
                  Weighed directly
                </span>
              ) : (
                formatHoney(h.superWeightBefore)
              ),
          },
        ),
        harvestColumnHelper.accessor(
          (h) => (h.directWeight ? undefined : h.superWeightAfter),
          {
            id: "after",
            header: "Super after",
            sortUndefined: "last",
            meta: rightAligned,
            cell: ({ row: { original: h } }) =>
              h.directWeight ? "—" : formatHoney(h.superWeightAfter),
          },
        ),
        harvestColumnHelper.accessor((h) => h.calculatedHoneyWeight, {
          id: "honey",
          header: "Honey",
          meta: { align: "right", cellClassName: "font-medium tabular-nums" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => formatHoney(getValue()),
        }),
      ]),
    [formatHoney],
  );

  const harvestTable = useTable({
    features: gridFeatures,
    columns: harvestColumns,
    data: standalone,
    getRowId: (harvest) => harvest.id,
  });

  const sessionRows = React.useMemo(
    () => sessions.data ?? [],
    [sessions.data],
  );

  const sessionColumns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((s) => s.date, {
          id: "date",
          header: "Date",
          cell: ({ row }) => formatDate(row.original.date),
        }),
        columnHelper.accessor((s) => s.apiaryName, {
          id: "apiary",
          header: "Apiary",
          meta: { cellClassName: "font-medium", filter: true, filterAllLabel: "All apiaries" } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.apiaryName,
        }),
        columnHelper.accessor((s) => SESSION_STATUS_LABELS[sessionStatus(s)], {
          id: "status",
          header: "Status",
          meta: { card: "badge", filter: true, filterAllLabel: "Any status" } satisfies DataGridColumnMeta,
          cell: ({ row }) => (
            <SessionStatusBadge status={sessionStatus(row.original)} />
          ),
        }),
        columnHelper.accessor((s) => s.entryCount, {
          id: "hives",
          header: "Hives",
          meta: rightAligned,
          cell: ({ row }) => row.original.entryCount,
        }),
        columnHelper.accessor((s) => s.calculatedTotal, {
          id: "calculated",
          header: "Calculated",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.calculatedTotal),
        }),
        columnHelper.accessor((s) => s.totalExtractedWeight ?? undefined, { sortUndefined: "last",
          id: "extracted",
          header: "Extracted",
          meta: rightAligned,
          cell: ({ row }) =>
            row.original.totalExtractedWeight != null
              ? formatHoney(row.original.totalExtractedWeight)
              : "—",
        }),
        columnHelper.display({
          id: "actions",
          header: "",
          meta: {
            cellClassName: "p-1 text-right",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: session } }) => (
            <DataGridCellAction className="flex justify-end">
              <Button asChild variant="ghost" size="sm">
                <Link href={`/production/sessions/${session.id}`}>
                  View
                  <ChevronRight />
                </Link>
              </Button>
            </DataGridCellAction>
          ),
        }),
      ]),
    [formatHoney],
  );

  const sessionTable = useTable({
    features: gridFeatures,
    columns: sessionColumns,
    data: sessionRows,
    getRowId: (session) => session.id,
  });

  return (
    <div className="grid gap-6">
      <div className="flex justify-end">
        <Button type="button" onClick={() => setRecordOpen(true)}>
          <Plus />
          Record harvest
        </Button>
      </div>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Harvest sessions</h2>
        {sessions.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : sessions.isError ? (
          <HarvestLoadError
            message={
              sessions.error instanceof ApiError && sessions.error.status === 403
                ? "Administrator access required"
                : "Could not load sessions."
            }
            onRetry={() => void sessions.refetch()}
          />
        ) : sessions.data.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No harvest sessions yet. Record harvest starts one for an
            extraction day at an apiary.
          </p>
        ) : (
          <div className="rounded-lg border">
            <DataGrid
              table={sessionTable}
              aria-label="Harvest sessions"
              onRowActivate={(session) =>
                router.push(`/production/sessions/${session.id}`)
              }
            />
          </div>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Single-hive harvests</h2>
        {harvests.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : harvests.isError ? (
          <HarvestLoadError
            message={
              harvests.error instanceof ApiError && harvests.error.status === 403
                ? "Administrator access required"
                : "Could not load harvests."
            }
            onRetry={() => void harvests.refetch()}
          />
        ) : standalone.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No single-hive harvests yet. Hives weighed during a session are
            listed on that session&apos;s page.
          </p>
        ) : (
          <div className="rounded-lg border">
            <DataGrid
              table={harvestTable}
              aria-label="Single-hive harvests"
              listenOnWindow={false}
              searchable={standalone.length > 8}
            />
          </div>
        )}
      </section>

      <RecordHarvestDialog open={recordOpen} onOpenChange={setRecordOpen} />
    </div>
  );
}

// --- record harvest dialog ---

type HarvestKind = "session" | "hive";

const HARVEST_KINDS: readonly [HarvestKind, string][] = [
  ["session", "Extraction day"],
  ["hive", "One hive"],
];

/**
 * The one way to record a harvest. An extraction day at an apiary becomes a
 * session (per-hive weights are added on its page); a hive weighed on its
 * own becomes a single-hive harvest.
 */
function RecordHarvestDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = React.useState<HarvestKind>("session");
  // Closing resets the choice, so the dialog reopens on the common case.
  const handleOpenChange = (next: boolean) => {
    if (!next) setKind("session");
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record harvest</DialogTitle>
          <DialogDescription>
            {kind === "session"
              ? "One extraction day at one apiary. Add each hive's weight on the session page next."
              : "One hive on its own: weigh its supers before and after, or the extracted honey directly."}
          </DialogDescription>
        </DialogHeader>
        <div
          role="group"
          aria-label="What are you recording?"
          className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1"
        >
          {HARVEST_KINDS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
              className={
                kind === value
                  ? "rounded-md bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-sm"
                  : "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              {label}
            </button>
          ))}
        </div>
        {kind === "session" ? (
          <SessionForm open={open} onClose={() => handleOpenChange(false)} />
        ) : (
          <HiveHarvestForm open={open} onClose={() => handleOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- session form ---

const sessionSchema = z.object({
  apiaryId: z.string().min(1, "Apiary is required"),
  date: z.string().min(1, "Date is required"),
  notes: z.string(),
  moisturePct: z.string(),
});
type SessionValues = z.infer<typeof sessionSchema>;

function SessionForm({
  open,
  onClose,
}: {
  /** The dialog's open state; the form resets when it opens. */
  open: boolean;
  onClose: () => void;
}) {
  const apiaries = useApiaryOptions();
  const mutation = useCreateSession();
  const form = useForm<SessionValues>({
    resolver: zodResolver(sessionSchema),
    defaultValues: { apiaryId: "", date: todayISO(), notes: "", moisturePct: "" },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({ apiaryId: "", date: todayISO(), notes: "", moisturePct: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submitSession = (resetAfter: boolean) => form.handleSubmit((values) => {
    mutation.mutate(
      {
        apiaryId: values.apiaryId,
        date: values.date,
        notes: values.notes.trim() || undefined,
        moisturePct: parseNum(values.moisturePct) ?? undefined,
      },
      {
        onSuccess: () => {
          if (resetAfter) form.reset({ apiaryId: "", date: todayISO(), notes: "", moisturePct: "" });
          else onClose();
        },
      },
    );
  });
  const onSubmit = submitSession(false);

  const { errors } = form.formState;
  return (
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitSession(true)}
          onEscape={onClose}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label>Apiary</Label>
            <Select
              value={form.watch("apiaryId")}
              onValueChange={(value) =>
                form.setValue("apiaryId", value, { shouldValidate: true })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose an apiary" />
              </SelectTrigger>
              <SelectContent>
                {(apiaries.data ?? []).map((apiary) => (
                  <SelectItem key={apiary.id} value={apiary.id}>
                    {apiary.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.apiaryId?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="session-date">Date</Label>
            <Input id="session-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="session-moisture">Refractometer moisture %</Label>
            <Input
              id="session-moisture"
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              max={100}
              placeholder="e.g. 17.8"
              {...form.register("moisturePct")}
            />
            <p className="text-xs text-muted-foreground">
              Honey wetter than the moisture limit in Setup (18.6% unless
              changed) cannot be harvested.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="session-notes">Notes</Label>
            <Textarea
              id="session-notes"
              rows={2}
              placeholder="Optional notes"
              {...form.register("notes")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Starting…" : "Start session"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
  );
}

// --- single-hive harvest form ---

const harvestSchema = z.object({
  hiveId: z.string().min(1, "Hive is required"),
  date: z.string().min(1, "Date is required"),
  superWeightBefore: z.string(),
  superWeightAfter: z.string(),
  harvestedWeight: z.string(),
  notes: z.string(),
});
type HarvestValues = z.infer<typeof harvestSchema>;

const EMPTY_HARVEST: HarvestValues = {
  hiveId: "",
  date: "",
  superWeightBefore: "",
  superWeightAfter: "",
  harvestedWeight: "",
  notes: "",
};

function HiveHarvestForm({
  open,
  onClose,
}: {
  /** The dialog's open state; the form resets when it opens. */
  open: boolean;
  onClose: () => void;
}) {
  const { formatHoney, units, honeySuffix } = useUnits();
  const hives = useHiveOptions();
  const mutation = useCreateHarvest();
  const [mode, setMode] = React.useState<"supers" | "direct">("supers");
  const form = useForm<HarvestValues>({
    resolver: zodResolver(harvestSchema),
    defaultValues: { ...EMPTY_HARVEST, date: todayISO() },
  });

  React.useEffect(() => {
    if (!open) return;
    setMode("supers");
    form.reset({ ...EMPTY_HARVEST, date: todayISO() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const before = parseHoneyWeight(form.watch("superWeightBefore"), units);
  const after = parseHoneyWeight(form.watch("superWeightAfter"), units);
  const direct = parseHoneyWeight(form.watch("harvestedWeight"), units);
  const calculated =
    mode === "direct"
      ? direct
      : before != null && after != null
        ? before - after
        : null;

  const finishHarvest = (resetAfter: boolean) => {
    if (resetAfter) {
      setMode("supers");
      form.reset({ ...EMPTY_HARVEST, date: todayISO() });
    } else {
      onClose();
    }
  };
  const submitHarvest = (resetAfter: boolean) => form.handleSubmit((values) => {
    if (mode === "direct") {
      const weight = parseHoneyWeight(values.harvestedWeight, units);
      if (weight == null || weight <= 0) {
        form.setError("harvestedWeight", {
          message: "Enter the harvested weight",
        });
        return;
      }
      mutation.mutate(
        {
          hiveId: values.hiveId,
          date: values.date,
          harvestedWeight: weight,
          notes: values.notes.trim() || undefined,
        },
        { onSuccess: () => finishHarvest(resetAfter) },
      );
      return;
    }
    const b = parseHoneyWeight(values.superWeightBefore, units);
    const a = parseHoneyWeight(values.superWeightAfter, units);
    if (b == null) {
      form.setError("superWeightBefore", {
        message: "Enter the super weight before extraction",
      });
      return;
    }
    if (a == null) {
      form.setError("superWeightAfter", {
        message: "Enter the super weight after extraction",
      });
      return;
    }
    if (b - a < 0) {
      form.setError("superWeightAfter", {
        message: "Super weight before must be greater than after",
      });
      return;
    }
    mutation.mutate(
      {
        hiveId: values.hiveId,
        date: values.date,
        superWeightBefore: b,
        superWeightAfter: a,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => finishHarvest(resetAfter) },
    );
  });
  const onSubmit = submitHarvest(false);

  const { errors } = form.formState;
  return (
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitHarvest(true)}
          onEscape={onClose}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label>Hive</Label>
            <Select
              value={form.watch("hiveId")}
              onValueChange={(value) =>
                form.setValue("hiveId", value, { shouldValidate: true })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a hive" />
              </SelectTrigger>
              <SelectContent>
                {(hives.data ?? []).map((hive) => (
                  <SelectItem key={hive.id} value={hive.id}>
                    {hive.positionLabel} — {hive.apiaryName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.hiveId?.message} />
            {(() => {
              const selected = (hives.data ?? []).find(
                (hive) => hive.id === form.watch("hiveId"),
              );
              if (!selected?.lockout?.locked) return null;
              return (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {selected.lockout.message}
                </p>
              );
            })()}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="harvest-date">Date</Label>
            <Input id="harvest-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          <div
            role="group"
            aria-label="Measurement method"
            className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1"
          >
            {(
              [
                ["supers", "Weigh supers"],
                ["direct", "Direct weight"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={
                  mode === value
                    ? "rounded-md bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-sm"
                    : "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "supers" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="harvest-before">
                  Super weight before ({honeySuffix})
                </Label>
                <Input
                  id="harvest-before"
                  inputMode="decimal"
                  placeholder={`e.g. 20 ${honeySuffix}`}
                  {...form.register("superWeightBefore")}
                />
                <FieldError message={errors.superWeightBefore?.message} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="harvest-after">Super weight after ({honeySuffix})</Label>
                <Input
                  id="harvest-after"
                  inputMode="decimal"
                  placeholder={`e.g. 5 ${honeySuffix}`}
                  {...form.register("superWeightAfter")}
                />
                <FieldError message={errors.superWeightAfter?.message} />
              </div>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="harvest-weight">Harvested weight ({honeySuffix})</Label>
              <Input
                id="harvest-weight"
                inputMode="decimal"
                placeholder={`e.g. 2 kg or 4.4 ${honeySuffix}`}
                {...form.register("harvestedWeight")}
              />
              <FieldError message={errors.harvestedWeight?.message} />
            </div>
          )}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {calculated != null ? (
              <Badge
                variant={calculated < 0 ? "destructive" : "accent"}
                className="tabular-nums"
              >
                Honey: {formatHoney(calculated)}
              </Badge>
            ) : mode === "supers" ? (
              "Honey = super weight before − after; it fills in as you type."
            ) : (
              "Type the weight of the extracted honey."
            )}
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="harvest-notes">Notes</Label>
            <Textarea
              id="harvest-notes"
              rows={2}
              placeholder="Optional notes"
              {...form.register("notes")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Record harvest"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
  );
}
