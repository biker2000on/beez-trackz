"use client";

/**
 * Bulk record: pick hives once on the A1–D4 grid, then record the same
 * inspection note, feeding, treatment series or mite count for all of them.
 *
 * Treatments and mite counts are one request per record, sent in turn with a
 * stable `X-Offline-Mutation-ID` each, so a retry after a dropped connection
 * replays the same ids and the server answers instead of saving twice.
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError, OfflineQueuedError } from "@/lib/api";
import { activeHives, hiveDisplayLabel } from "@/lib/hive-label";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  FEEDER_TYPES,
  FEEDING_TYPES,
  QUANTITY_UNITS,
  useBulkFeedings,
} from "@/features/feedings/hooks";
import { useHives, type Hive } from "@/features/hives/hooks";
import { todayInput } from "@/features/hives/lib";
import {
  HiveGridPicker,
  hiveGridOrder,
} from "@/features/inspections/hive-grid-picker";
import { useBulkInspections } from "@/features/inspections/hooks";
import {
  DEFAULT_SAMPLE_SIZE,
  isBoardMiteMethod,
  MITE_METHODS,
  type MiteMethod,
} from "@/features/inspections/inspection-fields";
import { useTreatmentProducts } from "@/features/settings/api";

type Kind = "inspection" | "feeding" | "treatment" | "mite";

const KINDS: { value: Kind; label: string }[] = [
  { value: "inspection", label: "Note" },
  { value: "feeding", label: "Feeding" },
  { value: "treatment", label: "Treatment" },
  { value: "mite", label: "Mite count" },
];

const TREATMENT_METHODS = ["Vaporization", "Dribble", "Strips", "Pads", "Spray"];

function addDays(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const shortDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

// --- one-request-per-record writes ------------------------------------------

interface PlannedWrite {
  key: string;
  /** "A3 · Sep 13" */
  label: string;
  path: string;
  body: Record<string, unknown>;
  mutationId: string;
  status: "pending" | "saved" | "queued" | "failed";
  error?: string;
}

/**
 * Holds a batch of writes until every one is saved. While some are not
 * saved, the form that made them is locked, so "Retry" resends exactly the
 * same bodies with the same mutation ids.
 */
function useWritePlan(onFinished: () => void) {
  const [plan, setPlan] = React.useState<PlannedWrite[] | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(
    null,
  );

  async function run(rows: PlannedWrite[]) {
    const todo = rows.filter((row) => row.status === "pending" || row.status === "failed");
    let current = rows;
    setPlan(current);
    setProgress({ done: 0, total: todo.length });
    let stopped = false;
    for (const [index, row] of todo.entries()) {
      let next: PlannedWrite;
      try {
        await api.post(row.path, row.body, {
          headers: { "X-Offline-Mutation-ID": row.mutationId },
        });
        next = { ...row, status: "saved", error: undefined };
      } catch (error) {
        if (error instanceof OfflineQueuedError) {
          next = { ...row, status: "queued", error: undefined };
        } else if (error instanceof ApiError) {
          next = { ...row, status: "failed", error: error.message };
        } else {
          next = {
            ...row,
            status: "failed",
            error: "No connection. Retry when you're back online.",
          };
          stopped = true;
        }
      }
      current = current.map((item) => (item.key === row.key ? next : item));
      setPlan(current);
      setProgress({ done: index + 1, total: todo.length });
      if (stopped) break;
    }
    setProgress(null);
    onFinished();
    const failed = current.filter((row) => row.status !== "saved" && row.status !== "queued");
    if (failed.length === 0) {
      const queued = current.filter((row) => row.status === "queued").length;
      toast.success(
        queued
          ? `${plural(current.length, "record")} kept on this device; they upload when you're back online`
          : `Saved ${plural(current.length, "record")}`,
      );
      setPlan(null);
      return true;
    }
    return false;
  }

  return { plan, progress, run, clear: () => setPlan(null) };
}

function PlanStatus({
  plan,
  progress,
  onRetry,
  onDiscard,
}: {
  plan: PlannedWrite[] | null;
  progress: { done: number; total: number } | null;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  if (progress)
    return (
      <div className="grid gap-1">
        <p role="status" className="text-sm font-medium">
          Saving… {progress.done} of {progress.total} done
        </p>
        <progress
          className="h-2 w-full accent-primary"
          value={progress.done}
          max={progress.total}
          aria-label="Saving progress"
        />
      </div>
    );
  if (!plan) return null;
  const failed = plan.filter((row) => row.status === "failed" || row.status === "pending");
  const saved = plan.filter((row) => row.status === "saved").length;
  return (
    <div role="alert" className="grid gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
      <p className="font-medium">
        {saved} of {plan.length} saved. {plural(failed.length, "record")} not saved:
      </p>
      <ul className="grid gap-1">
        {failed.map((row) => (
          <li key={row.key}>
            <span className="font-medium">{row.label}</span>
            {row.error ? ` · ${row.error}` : " · not sent yet"}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        The form is locked so a retry sends exactly the same records.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="min-h-11" onClick={onRetry}>
          Retry {plural(failed.length, "record")}
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={onDiscard}>
          Leave them unsaved
        </Button>
      </div>
    </div>
  );
}

// --- page --------------------------------------------------------------------

export function BulkActionsTab({ apiaryId }: { apiaryId: string }) {
  const hiveQuery = useHives({ apiaryId, includeArchived: true });
  const all = React.useMemo(() => hiveQuery.data ?? [], [hiveQuery.data]);
  const hives = React.useMemo(() => hiveGridOrder(activeHives(all)), [all]);
  const labelFor = React.useCallback((hive: Hive) => hiveDisplayLabel(hive, all), [all]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [kind, setKind] = React.useState<Kind>("inspection");
  // Selection survives a save, so "feed every hive, then note every hive"
  // is one pick; it only ever holds active hives.
  const chosen = hives.filter((hive) => selected.has(hive.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="grid gap-5">
      <section className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5" aria-label="Hives">
        {hiveQuery.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : hiveQuery.isError ? (
          <p role="alert" className="text-sm">
            Hives could not be loaded.{" "}
            <Button variant="outline" size="sm" onClick={() => void hiveQuery.refetch()}>
              Retry
            </Button>
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {chosen.length === 0
                  ? "Choose hives"
                  : `${plural(chosen.length, "hive")} chosen`}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={hives.length === 0 || chosen.length === hives.length}
                  onClick={() => setSelected(new Set(hives.map((hive) => hive.id)))}
                >
                  Choose all {hives.length}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={chosen.length === 0}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
              </div>
            </div>
            <HiveGridPicker
              hives={hives}
              selected={selected}
              onSelect={(hive) => toggle(hive.id)}
              labelFor={labelFor}
              legend="Hives to record for"
              hideLegend
              emptyText="No active hives in this apiary yet."
            />
          </>
        )}
      </section>

      <fieldset className="grid min-w-0 gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">What to record</legend>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
          {KINDS.map((option) => (
            <label
              key={option.value}
              className={cn(
                "relative flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
                kind === option.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background hover:bg-secondary",
              )}
            >
              <input
                type="radio"
                name="bulk-kind"
                className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
                value={option.value}
                checked={kind === option.value}
                onChange={() => setKind(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <section className="rounded-xl border bg-card p-4 sm:p-5" aria-label="Record">
        {kind === "inspection" ? (
          <BulkInspectionForm hives={chosen} />
        ) : kind === "feeding" ? (
          <BulkFeedingForm hives={chosen} />
        ) : kind === "treatment" ? (
          <BulkTreatmentForm apiaryId={apiaryId} hives={chosen} />
        ) : (
          <BulkMiteForm apiaryId={apiaryId} hives={chosen} />
        )}
      </section>
    </div>
  );
}

function useInvalidateYard(apiaryId: string) {
  const client = useQueryClient();
  return () => {
    for (const queryKey of [
      ["hives"],
      ["work"],
      ["analytics"],
      ["mite-counts"],
      ["inspections"],
      ["apiaries", "detail", apiaryId, "activity"],
    ])
      void client.invalidateQueries({ queryKey });
  };
}

function SubmitRow({
  disabled,
  label,
  hint,
}: {
  disabled: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button type="submit" className="min-h-12" disabled={disabled}>
        {label}
      </Button>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// --- note --------------------------------------------------------------------

function BulkInspectionForm({ hives }: { hives: Hive[] }) {
  const bulkInspections = useBulkInspections();
  const [date, setDate] = React.useState(todayInput());
  const [notes, setNotes] = React.useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (hives.length === 0) {
      toast.error("Choose at least one hive");
      return;
    }
    try {
      const result = await bulkInspections.mutateAsync({
        hiveIds: hives.map((hive) => hive.id),
        date,
        notes: notes.trim() === "" ? null : notes,
      });
      toast.success(`Saved ${plural(result.count, "inspection")}`);
      setNotes("");
    } catch (error) {
      toast.error(
        error instanceof OfflineQueuedError
          ? "Kept on this device; it uploads when you're back online"
          : error instanceof ApiError
            ? error.message
            : "Could not save the inspections",
      );
    }
  }

  return (
    <ShortcutForm onSubmit={onSubmit} className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        One inspection per hive with the same note, for a quick lid-pop round.
      </p>
      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor="bulk-inspect-date">Date</Label>
        <Input
          id="bulk-inspect-date"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="bulk-inspect-notes">Note</Label>
        <Textarea
          id="bulk-inspect-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Lid popped, all strong"
        />
      </div>
      <SubmitRow
        disabled={bulkInspections.isPending || hives.length === 0}
        label={
          bulkInspections.isPending
            ? "Saving…"
            : `Save note for ${plural(hives.length, "hive")}`
        }
      />
    </ShortcutForm>
  );
}

// --- feeding -----------------------------------------------------------------

function BulkFeedingForm({ hives }: { hives: Hive[] }) {
  const bulkFeedings = useBulkFeedings();
  const [dateFed, setDateFed] = React.useState(todayInput());
  const [type, setType] = React.useState<string>("sugar_syrup_1to1");
  const [quantity, setQuantity] = React.useState("");
  const [unit, setUnit] = React.useState<string>("gallons");
  const [feederType, setFeederType] = React.useState<string>("none");
  const [notes, setNotes] = React.useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (hives.length === 0) {
      toast.error("Choose at least one hive");
      return;
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Enter an amount above zero");
      return;
    }
    try {
      const result = await bulkFeedings.mutateAsync({
        hiveIds: hives.map((hive) => hive.id),
        dateFed,
        type,
        quantity: qty,
        quantityUnit: unit,
        feederType: feederType === "none" ? null : feederType,
        notes: notes.trim() === "" ? null : notes,
      });
      toast.success(`Saved ${plural(result.count, "feeding")}`);
      setQuantity("");
      setNotes("");
    } catch (error) {
      toast.error(
        error instanceof OfflineQueuedError
          ? "Kept on this device; it uploads when you're back online"
          : error instanceof ApiError
            ? error.message
            : "Could not save the feedings",
      );
    }
  }

  return (
    <ShortcutForm onSubmit={onSubmit} className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        The same feeding for every chosen hive. The amount is per hive.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="bulk-feed-date">Date</Label>
          <Input
            id="bulk-feed-date"
            type="date"
            value={dateFed}
            onChange={(event) => setDateFed(event.target.value)}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="bulk-feed-type">Feed</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger id="bulk-feed-type">
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
        <div className="grid gap-1.5">
          <Label htmlFor="bulk-feed-qty">Amount per hive</Label>
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
        <div className="grid gap-1.5">
          <Label htmlFor="bulk-feed-unit">Unit</Label>
          <Select value={unit} onValueChange={setUnit}>
            <SelectTrigger id="bulk-feed-unit">
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
      <div className="grid gap-1.5">
        <Label htmlFor="bulk-feed-feeder">Feeder</Label>
        <Select value={feederType} onValueChange={setFeederType}>
          <SelectTrigger id="bulk-feed-feeder">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No feeder, fed directly</SelectItem>
            {FEEDER_TYPES.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {feederType === "none"
            ? "Saved as one-time feeds; nothing stays on the hives to track."
            : "Each hive gets an open feeder to refill or close later."}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="bulk-feed-notes">Note</Label>
        <Textarea
          id="bulk-feed-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <SubmitRow
        disabled={bulkFeedings.isPending || hives.length === 0}
        label={bulkFeedings.isPending ? "Saving…" : `Feed ${plural(hives.length, "hive")}`}
      />
    </ShortcutForm>
  );
}

// --- treatment ---------------------------------------------------------------

function BulkTreatmentForm({ apiaryId, hives }: { apiaryId: string; hives: Hive[] }) {
  const products = useTreatmentProducts();
  const invalidate = useInvalidateYard(apiaryId);
  const writes = useWritePlan(invalidate);
  const [product, setProduct] = React.useState("");
  const [method, setMethod] = React.useState("");
  const [dates, setDates] = React.useState<string[]>(() => [todayInput()]);
  const [spacing, setSpacing] = React.useState("5");
  /** null follows the product catalog; a boolean is the beekeeper's choice. */
  const [endSameDayChoice, setEndSameDay] = React.useState<boolean | null>(null);
  const [notes, setNotes] = React.useState("");
  const locked = writes.plan !== null || writes.progress !== null;

  const catalogMatch = products.data?.find((item) =>
    [item.name, ...item.aliases].some(
      (name) => name.toLowerCase() === product.trim().toLowerCase(),
    ),
  );
  // The catalog marks single-application products (oxalic acid) "One-shot".
  const oneShot = /^one-shot/i.test(catalogMatch?.notes?.trim() ?? "");
  const endSameDay = endSameDayChoice ?? oneShot;
  const validDates = [...new Set(dates.filter(Boolean))].sort();
  const total = hives.length * validDates.length;

  function build(): PlannedWrite[] {
    return hives.flatMap((hive) =>
      validDates.map((date) => ({
        key: `${hive.id}|${date}`,
        label: `${hive.positionLabel} · ${shortDate(date)}`,
        path: "/treatment-events",
        body: {
          hiveId: hive.id,
          dateApplied: date,
          product: product.trim(),
          method: method.trim() || undefined,
          dateRemoved: endSameDay ? date : undefined,
          notes: notes.trim() || undefined,
        },
        mutationId: crypto.randomUUID(),
        status: "pending" as const,
      })),
    );
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (locked) return;
    if (hives.length === 0) return void toast.error("Choose at least one hive");
    if (!product.trim()) return void toast.error("Name the product");
    if (validDates.length === 0) return void toast.error("Add at least one date");
    const done = await writes.run(build());
    if (done) {
      setNotes("");
      setDates([todayInput()]);
    }
  }

  return (
    <ShortcutForm onSubmit={onSubmit} className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        One treatment record per hive for each date, so a vaporization series
        on five dates is five records per hive.
      </p>
      <fieldset disabled={locked} className="grid min-w-0 gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-treat-product">Product</Label>
            <Input
              id="bulk-treat-product"
              list="bulk-treat-products"
              value={product}
              onChange={(event) => setProduct(event.target.value)}
              placeholder="Oxalic acid"
              required
            />
            <datalist id="bulk-treat-products">
              {products.data?.map((item) => <option key={item.id} value={item.name} />)}
            </datalist>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-treat-method">Method</Label>
            <Input
              id="bulk-treat-method"
              list="bulk-treat-methods"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              placeholder="Vaporization"
            />
            <datalist id="bulk-treat-methods">
              {TREATMENT_METHODS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
        </div>

        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-1 text-sm font-medium">Dates applied</legend>
          <ol className="grid gap-2">
            {dates.map((date, index) => (
              <li key={index} className="flex items-end gap-2">
                <div className="grid flex-1 gap-1 sm:max-w-xs">
                  <Label htmlFor={`bulk-treat-date-${index}`} className="text-xs">
                    Date {index + 1}
                  </Label>
                  <Input
                    id={`bulk-treat-date-${index}`}
                    type="date"
                    value={date}
                    onChange={(event) =>
                      setDates((rows) =>
                        rows.map((row, i) => (i === index ? event.target.value : row)),
                      )
                    }
                  />
                </div>
                {dates.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove date ${index + 1}`}
                    onClick={() => setDates((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid w-28 gap-1">
              <Label htmlFor="bulk-treat-interval" className="text-xs">
                Days apart
              </Label>
              <Input
                id="bulk-treat-interval"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={spacing}
                onChange={(event) => setSpacing(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() =>
                setDates((rows) => {
                  const last = [...rows].filter(Boolean).sort().at(-1) ?? todayInput();
                  const step = Math.max(1, Math.floor(Number(spacing)) || 1);
                  return [...rows, addDays(last, step)];
                })
              }
            >
              <Plus />
              Add the next date
            </Button>
          </div>
        </fieldset>

        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={endSameDay}
            onCheckedChange={(checked) => setEndSameDay(checked === true)}
          />
          <span>
            Each application ends the same day
            <span className="block text-muted-foreground">
              {oneShot
                ? `${catalogMatch?.name} is a single application, so the hive is not left marked as under treatment.`
                : "Leave unticked for strips or pads you remove later; end them from the hive record."}
            </span>
          </span>
        </label>

        <div className="grid gap-1.5">
          <Label htmlFor="bulk-treat-notes">Note</Label>
          <Textarea
            id="bulk-treat-notes"
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </fieldset>
      <PlanStatus
        plan={writes.plan}
        progress={writes.progress}
        onRetry={() => writes.plan && void writes.run(writes.plan)}
        onDiscard={writes.clear}
      />
      {!locked ? (
        <SubmitRow
          disabled={total === 0 || !product.trim()}
          label={`Save ${plural(total, "treatment record")}`}
          hint={
            hives.length && validDates.length
              ? `${plural(hives.length, "hive")} × ${plural(validDates.length, "date")}`
              : undefined
          }
        />
      ) : null}
    </ShortcutForm>
  );
}

// --- mite count --------------------------------------------------------------

function BulkMiteForm({ apiaryId, hives }: { apiaryId: string; hives: Hive[] }) {
  const invalidate = useInvalidateYard(apiaryId);
  const writes = useWritePlan(invalidate);
  const [date, setDate] = React.useState(todayInput());
  const [method, setMethod] = React.useState<MiteMethod>("alcohol_wash");
  const [sampleSize, setSampleSize] = React.useState(DEFAULT_SAMPLE_SIZE);
  const [daysOnBoard, setDaysOnBoard] = React.useState("1");
  const [counts, setCounts] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState("");
  const locked = writes.plan !== null || writes.progress !== null;
  const board = isBoardMiteMethod(method);
  const entered = hives.filter((hive) => (counts[hive.id] ?? "").trim() !== "");
  const invalidCount = entered.some((hive) => {
    const value = Number(counts[hive.id]);
    return !Number.isInteger(value) || value < 0;
  });
  const settingValue = Number(board ? daysOnBoard : sampleSize);
  const invalidSetting = !Number.isInteger(settingValue) || settingValue <= 0;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (locked) return;
    if (entered.length === 0)
      return void toast.error("Enter a mite count for at least one hive");
    if (invalidCount) return void toast.error("Mite counts are whole numbers");
    if (invalidSetting)
      return void toast.error(board ? "Enter the days the board was in" : "Enter how many bees were sampled");
    const done = await writes.run(
      entered.map((hive) => ({
        key: hive.id,
        label: hive.positionLabel,
        path: "/mite-counts",
        body: {
          hiveId: hive.id,
          date,
          method,
          mitesCount: Number(counts[hive.id]),
          sampleSize: board ? undefined : settingValue,
          daysOnBoard: board ? settingValue : undefined,
          notes: notes.trim() || undefined,
        },
        mutationId: crypto.randomUUID(),
        status: "pending" as const,
      })),
    );
    if (done) {
      setCounts({});
      setNotes("");
    }
  }

  return (
    <ShortcutForm onSubmit={onSubmit} className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        The same test on several hives, each with its own count. Leave a hive
        blank to skip it.
      </p>
      <fieldset disabled={locked} className="grid min-w-0 gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-mite-date">Date</Label>
            <Input
              id="bulk-mite-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-mite-method">Method</Label>
            <Select value={method} onValueChange={(next) => setMethod(next as MiteMethod)}>
              <SelectTrigger id="bulk-mite-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MITE_METHODS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {board ? (
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-mite-days">Days on board</Label>
              <Input
                id="bulk-mite-days"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={daysOnBoard}
                onChange={(event) => setDaysOnBoard(event.target.value)}
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-mite-sample">Bees sampled</Label>
              <Input
                id="bulk-mite-sample"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={sampleSize}
                onChange={(event) => setSampleSize(event.target.value)}
              />
            </div>
          )}
        </div>

        {hives.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Choose hives above to enter their counts.
          </p>
        ) : (
          <fieldset className="grid min-w-0 gap-2">
            <legend className="mb-1 text-sm font-medium">Mites found</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {hives.map((hive) => (
                <div key={hive.id} className="grid gap-1">
                  <Label htmlFor={`bulk-mite-${hive.id}`} className="text-xs">
                    {hive.positionLabel}
                  </Label>
                  <Input
                    id={`bulk-mite-${hive.id}`}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={counts[hive.id] ?? ""}
                    onChange={(event) =>
                      setCounts((rows) => ({ ...rows, [hive.id]: event.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          </fieldset>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="bulk-mite-notes">Note</Label>
          <Textarea
            id="bulk-mite-notes"
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </fieldset>
      <PlanStatus
        plan={writes.plan}
        progress={writes.progress}
        onRetry={() => writes.plan && void writes.run(writes.plan)}
        onDiscard={writes.clear}
      />
      {!locked ? (
        <SubmitRow
          disabled={entered.length === 0}
          label={`Save ${plural(entered.length, "mite count")}`}
          hint={
            hives.length > entered.length && entered.length > 0
              ? `${plural(hives.length - entered.length, "hive")} left blank, skipped`
              : undefined
          }
        />
      ) : null}
    </ShortcutForm>
  );
}
