"use client";

/**
 * One set of inspection fields for every way an inspection is entered: the
 * typed Log inspection dialog and the voice review (single hive and the visit
 * ledger). A Quick set covers the usual one-line visit (note, queen, temper,
 * a mite wash); everything else sits behind "More detail".
 *
 * The value is string-friendly form state. Callers convert it to their own
 * payload (`toInspectionPayload` in the dialog, `toConfirmPayload` in the
 * voice review) so this component never depends on either API.
 */

import * as React from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type MiteMethod = "alcohol_wash" | "sugar_roll" | "sticky_board" | "visual";
export type FeedingType =
  | "sugar_syrup_1to1"
  | "sugar_syrup_2to1"
  | "dry_sugar"
  | "pollen_patty"
  | "fondant"
  | "other";
export type QuantityUnit = "lbs" | "oz" | "quarts" | "gallons";
export type FeederType =
  | "entrance"
  | "top"
  | "frame"
  | "baggie"
  | "bucket"
  | "open"
  | "other";
export type QueenEventType =
  | "observed"
  | "introduced"
  | "superseded"
  | "missing"
  | "dead"
  | "requeened";

export interface MiteCountRow {
  /** Server id when editing an existing count. */
  id?: string;
  method: MiteMethod;
  mitesCount: string;
  sampleSize: string;
  daysOnBoard: string;
  notes: string;
}

/** Editable, string-friendly form state for one inspection. */
export interface InspectionFieldValues {
  /** What the recording called the hive; carried through, never edited. */
  hiveReference: string | null;
  /** Tri-state: null means not checked, never "not seen". */
  queenSeen: boolean | null;
  queenHealth: string;
  broodPattern: string;
  storesHoney: string;
  storesPollen: string;
  temperament: string;
  framesOfBees: string;
  framesOfBrood: string;
  framesOfStores: string;
  pests: { type: string; count: string }[];
  treatments: { product: string; method: string }[];
  feedings: {
    type: FeedingType;
    quantity: string;
    quantityUnit: QuantityUnit;
    feederType: FeederType;
    notes: string;
  }[];
  queenEvents: { eventType: QueenEventType; notes: string }[];
  miteCounts: MiteCountRow[];
  notes: string;
}

/** Field path → message, e.g. `miteCounts.0.mitesCount`. */
export type InspectionFieldErrors = Partial<Record<string, string>>;

export const DEFAULT_SAMPLE_SIZE = "300";

export const TEMPERAMENT_LABELS: Record<string, string> = {
  "1": "Calm",
  "2": "Mostly calm",
  "3": "Moderate",
  "4": "Defensive",
  "5": "Aggressive",
};

const STORES_LABELS: Record<string, string> = {
  "1": "Low",
  "2": "Light",
  "3": "Moderate",
  "4": "Good",
  "5": "Full",
};

export const BROOD_PATTERNS = [
  "excellent",
  "good",
  "fair",
  "poor",
  "spotty",
  "none",
] as const;

export const MITE_METHODS: { value: MiteMethod; label: string }[] = [
  { value: "alcohol_wash", label: "Alcohol wash" },
  { value: "sugar_roll", label: "Sugar roll" },
  { value: "sticky_board", label: "Sticky board" },
  { value: "visual", label: "Visual count" },
];

const FEEDING_TYPE_LABELS: [FeedingType, string][] = [
  ["sugar_syrup_1to1", "1:1 syrup"],
  ["sugar_syrup_2to1", "2:1 syrup"],
  ["dry_sugar", "Dry sugar"],
  ["pollen_patty", "Pollen patty"],
  ["fondant", "Fondant"],
  ["other", "Other"],
];

const FEEDER_LABELS: [FeederType, string][] = [
  ["entrance", "Entrance feeder"],
  ["top", "Top feeder"],
  ["frame", "Frame feeder"],
  ["baggie", "Baggie"],
  ["bucket", "Bucket"],
  ["open", "Open feeding"],
  ["other", "Other"],
];

const QUANTITY_UNITS: QuantityUnit[] = ["gallons", "quarts", "lbs", "oz"];

export const QUEEN_EVENT_LABELS: Record<QueenEventType, string> = {
  observed: "Queen seen",
  introduced: "Queen introduced",
  superseded: "Supersedure",
  missing: "Queen missing",
  dead: "Queen dead",
  requeened: "Requeened",
};

/** Radix Select forbids empty item values; sentinel for "not recorded". */
const UNSET = "not-recorded";

export function isBoardMiteMethod(method: string): boolean {
  return method === "sticky_board" || method === "visual";
}

export function temperamentText(value: number | null | undefined): string | null {
  if (value == null) return null;
  return TEMPERAMENT_LABELS[String(value)] ?? null;
}

export function feedingTypeShort(type: string): string {
  return FEEDING_TYPE_LABELS.find(([value]) => value === type)?.[1] ?? type;
}

export function miteMethodLabel(method: string): string {
  return MITE_METHODS.find((item) => item.value === method)?.label ?? method;
}

export function emptyMiteRow(method: MiteMethod = "alcohol_wash"): MiteCountRow {
  return {
    method,
    mitesCount: "",
    sampleSize: DEFAULT_SAMPLE_SIZE,
    daysOnBoard: "1",
    notes: "",
  };
}

export function emptyInspectionValues(): InspectionFieldValues {
  return {
    hiveReference: null,
    queenSeen: null,
    queenHealth: "",
    broodPattern: "",
    storesHoney: "",
    storesPollen: "",
    temperament: "",
    framesOfBees: "",
    framesOfBrood: "",
    framesOfStores: "",
    pests: [],
    treatments: [],
    feedings: [],
    queenEvents: [],
    miteCounts: [],
    notes: "",
  };
}

/**
 * Fills fields that older drafts on this device were saved without (frames,
 * days on board), so a draft recorded before an update still opens.
 */
export function normalizeInspectionValues(
  stored: Partial<InspectionFieldValues> | null | undefined,
): InspectionFieldValues {
  const base = emptyInspectionValues();
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    queenSeen: stored.queenSeen ?? null,
    pests: stored.pests ?? [],
    treatments: stored.treatments ?? [],
    feedings: stored.feedings ?? [],
    queenEvents: stored.queenEvents ?? [],
    miteCounts: (stored.miteCounts ?? []).map((row) => ({
      ...emptyMiteRow(row.method),
      ...row,
      sampleSize: row.sampleSize ?? DEFAULT_SAMPLE_SIZE,
      daysOnBoard: row.daysOnBoard ?? "1",
      notes: row.notes ?? "",
    })),
  };
}

const wholeNumber = (value: string) =>
  value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) >= 0;

/**
 * A mite row with no number is "not recorded": it is skipped by validation
 * and dropped from every payload. Clearing the number of an existing count is
 * how it is removed.
 */
export function isBlankMiteRow(row: Pick<MiteCountRow, "mitesCount">): boolean {
  return row.mitesCount.trim() === "";
}

/**
 * Problems that would make the save fail or lose data. An empty result means
 * the inspection can be saved. `daysOnBoard` checks board counts the typed
 * form records; the voice review has no days-on-board field.
 */
export function validateInspectionValues(
  value: InspectionFieldValues,
  options: { daysOnBoard?: boolean } = {},
): InspectionFieldErrors {
  const errors: InspectionFieldErrors = {};
  const seen = new Set<string>();
  value.miteCounts.forEach((row, index) => {
    if (isBlankMiteRow(row)) return;
    if (seen.has(row.method))
      errors[`miteCounts.${index}.method`] = "Each method can be recorded once";
    seen.add(row.method);
    if (!wholeNumber(row.mitesCount))
      errors[`miteCounts.${index}.mitesCount`] = "Enter a whole number of mites";
    if (isBoardMiteMethod(row.method)) {
      if (
        options.daysOnBoard &&
        (!wholeNumber(row.daysOnBoard) || Number(row.daysOnBoard) <= 0)
      )
        errors[`miteCounts.${index}.daysOnBoard`] =
          "Enter days the board was in";
    } else if (!wholeNumber(row.sampleSize) || Number(row.sampleSize) <= 0) {
      errors[`miteCounts.${index}.sampleSize`] = "Enter how many bees";
    }
  });
  value.feedings.forEach((feeding, index) => {
    const quantity = Number(feeding.quantity);
    if (!feeding.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0)
      errors[`feedings.${index}.quantity`] = "Enter an amount above zero";
  });
  value.pests.forEach((pest, index) => {
    if (!pest.type.trim()) errors[`pests.${index}.type`] = "Name the pest";
  });
  value.treatments.forEach((treatment, index) => {
    if (!treatment.product.trim())
      errors[`treatments.${index}.product`] = "Name the product";
  });
  (["framesOfBees", "framesOfBrood", "framesOfStores"] as const).forEach(
    (name) => {
      if (value[name].trim() !== "" && !wholeNumber(value[name]))
        errors[name] = "Enter a whole number";
    },
  );
  return errors;
}

/** How many "More detail" fields hold something, for the disclosure label. */
function detailCount(value: InspectionFieldValues): number {
  return (
    [
      value.queenHealth,
      value.broodPattern,
      value.storesHoney,
      value.storesPollen,
      value.framesOfBees,
      value.framesOfBrood,
      value.framesOfStores,
    ].filter((item) => item.trim() !== "").length +
    Math.max(0, value.miteCounts.length - 1) +
    value.feedings.length +
    value.queenEvents.length +
    value.pests.length +
    value.treatments.length
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}

/** A row of radio buttons drawn as a segmented control. */
function Segmented<T extends string>({
  name,
  legend,
  hint,
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  name: string;
  legend: React.ReactNode;
  hint?: React.ReactNode;
  options: { value: T; label: React.ReactNode; srLabel?: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <fieldset className={cn("grid min-w-0 gap-1.5", className)} disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "relative flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 text-center text-sm font-medium transition-colors",
              "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
              "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
              value === option.value
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-background hover:bg-secondary",
            )}
          >
            <input
              type="radio"
              className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.srLabel ? (
              <>
                <span aria-hidden="true">{option.label}</span>
                <span className="sr-only">{option.srLabel}</span>
              </>
            ) : (
              option.label
            )}
          </label>
        ))}
      </div>
      {hint}
    </fieldset>
  );
}

function RatingSelect({
  id,
  label,
  value,
  onChange,
  labels,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  labels: Record<string, string>;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value || UNSET}
        onValueChange={(next) => onChange(next === UNSET ? "" : next)}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>Not recorded</SelectItem>
          {["1", "2", "3", "4", "5"].map((n) => (
            <SelectItem key={n} value={n}>
              {n} · {labels[n]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ListHeader({
  title,
  addLabel,
  onAdd,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-sm font-medium">{title}</h4>
      <Button type="button" variant="outline" size="sm" onClick={onAdd}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}

export interface InspectionFieldsProps {
  value: InspectionFieldValues;
  onChange: (value: InspectionFieldValues) => void;
  /** Unique prefix so labels stay linked when several editors are on a page. */
  idPrefix: string;
  disabled?: boolean;
  errors?: InspectionFieldErrors;
  /** Sections only some save paths accept. */
  include?: {
    /** Feedings and queen events (voice confirm creates those records). */
    feedingsAndQueenEvents?: boolean;
    /** Days a sticky board was in (typed form only). */
    daysOnBoard?: boolean;
  };
}

/**
 * The inspection fields: a Quick set (note, queen, temperament, mite wash)
 * and a "More detail" disclosure for the rest. Every input has a label.
 */
export function InspectionFields({
  value,
  onChange,
  idPrefix,
  disabled,
  errors = {},
  include = {},
}: InspectionFieldsProps) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const set = <K extends keyof InspectionFieldValues>(
    key: K,
    next: InspectionFieldValues[K],
  ) => onChange({ ...value, [key]: next });
  const filled = detailCount(value);
  // Open by default only when the record already carries detail, so a quick
  // one-line visit stays one screen tall.
  const [detailOpen, setDetailOpen] = React.useState(() => filled > 0);
  const errorCountInDetail = Object.keys(errors).filter(
    (key) =>
      !key.startsWith("miteCounts.0.") && !["notes"].includes(key),
  ).length;
  const showDetail = detailOpen || errorCountInDetail > 0;

  const invalid = (path: string) =>
    errors[path]
      ? { "aria-invalid": true as const, "aria-describedby": id(`${path}-error`) }
      : {};

  const quickMite: MiteCountRow = value.miteCounts[0] ?? emptyMiteRow();
  const quickBoard = isBoardMiteMethod(quickMite.method);
  function setQuickMite(patch: Partial<MiteCountRow>) {
    // A row without a mite number is dropped at save time, so the quick row
    // can exist while the beekeeper is still choosing a method.
    set("miteCounts", [{ ...quickMite, ...patch }, ...value.miteCounts.slice(1)]);
  }
  function setMite(index: number, patch: Partial<MiteCountRow>) {
    set(
      "miteCounts",
      value.miteCounts.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  const queenValue =
    value.queenSeen === null ? "unknown" : value.queenSeen ? "seen" : "not-seen";
  const broodOptions: string[] = [...BROOD_PATTERNS];
  if (value.broodPattern && !broodOptions.includes(value.broodPattern))
    broodOptions.unshift(value.broodPattern);

  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={id("notes")}>Note</Label>
        <Textarea
          id={id("notes")}
          rows={2}
          value={value.notes}
          onChange={(event) => set("notes", event.target.value)}
          placeholder="Lid popped, busy entrance, plenty of stores"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Segmented
          name={id("queen")}
          legend="Queen"
          value={queenValue}
          onChange={(next) =>
            set("queenSeen", next === "unknown" ? null : next === "seen")
          }
          options={[
            { value: "seen", label: "Seen" },
            { value: "not-seen", label: "Not seen" },
            { value: "unknown", label: "Not checked" },
          ]}
        />
        <Segmented
          name={id("temperament")}
          legend={
            <span className="flex flex-wrap items-baseline gap-x-2">
              Temperament
              <span className="text-xs font-normal text-muted-foreground">
                {value.temperament
                  ? `${value.temperament} · ${TEMPERAMENT_LABELS[value.temperament]}`
                  : "1 calm, 5 aggressive"}
              </span>
            </span>
          }
          value={value.temperament}
          onChange={(next) => set("temperament", next)}
          options={["1", "2", "3", "4", "5"].map((n) => ({
            value: n,
            label: n,
            srLabel: `${n}, ${TEMPERAMENT_LABELS[n].toLowerCase()}`,
          }))}
          hint={
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Calm</span>
              {value.temperament ? (
                <button
                  type="button"
                  className="min-h-8 rounded px-2 underline underline-offset-4 hover:text-foreground"
                  onClick={() => set("temperament", "")}
                >
                  Clear temperament
                </button>
              ) : null}
              <span>Aggressive</span>
            </div>
          }
        />
      </div>

      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-1.5 text-sm font-medium">Mite count</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1.3fr_1fr_1fr]">
          <div className="col-span-2 grid gap-1 sm:col-span-1">
            <Label htmlFor={id("mite-0-method")} className="text-xs">
              Method
            </Label>
            <Select
              value={quickMite.method}
              onValueChange={(next) => setQuickMite({ method: next as MiteMethod })}
            >
              <SelectTrigger id={id("mite-0-method")} {...invalid("miteCounts.0.method")}>
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
          <div className="grid gap-1">
            <Label htmlFor={id("mite-0-count")} className="text-xs">
              Mites found
            </Label>
            <Input
              id={id("mite-0-count")}
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={quickMite.mitesCount}
              onChange={(event) => setQuickMite({ mitesCount: event.target.value })}
              {...invalid("miteCounts.0.mitesCount")}
            />
          </div>
          {quickBoard ? (
            include.daysOnBoard ? (
              <div className="grid gap-1">
                <Label htmlFor={id("mite-0-days")} className="text-xs">
                  Days on board
                </Label>
                <Input
                  id={id("mite-0-days")}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={quickMite.daysOnBoard}
                  onChange={(event) =>
                    setQuickMite({ daysOnBoard: event.target.value })
                  }
                  {...invalid("miteCounts.0.daysOnBoard")}
                />
              </div>
            ) : null
          ) : (
            <div className="grid gap-1">
              <Label htmlFor={id("mite-0-sample")} className="text-xs">
                Bees sampled
              </Label>
              <Input
                id={id("mite-0-sample")}
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={quickMite.sampleSize}
                onChange={(event) => setQuickMite({ sampleSize: event.target.value })}
                {...invalid("miteCounts.0.sampleSize")}
              />
            </div>
          )}
        </div>
        {(["method", "mitesCount", "sampleSize", "daysOnBoard"] as const).map(
          (field) => (
            <FieldError
              key={field}
              id={id(`miteCounts.0.${field}-error`)}
              message={errors[`miteCounts.0.${field}`]}
            />
          ),
        )}
      </fieldset>

      <div className="grid gap-4 rounded-lg border">
        <button
          type="button"
          aria-expanded={showDetail}
          aria-controls={id("detail")}
          onClick={() => setDetailOpen((open) => !open)}
          className="flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 text-left text-sm font-medium hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>
            More detail
            {filled > 0 ? (
              <span className="ml-2 font-normal text-muted-foreground">
                {filled} filled in
              </span>
            ) : (
              <span className="ml-2 font-normal text-muted-foreground">
                Brood, stores, frames, pests, treatments
                {include.feedingsAndQueenEvents ? ", feeding" : ""}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn("size-4 shrink-0 transition-transform", showDetail && "rotate-180")}
            aria-hidden="true"
          />
        </button>
        {showDetail ? (
          <div id={id("detail")} className="grid gap-5 px-3 pb-4">
            <div className="grid gap-1.5">
              <Label htmlFor={id("queen-health")}>Queen health</Label>
              <Input
                id={id("queen-health")}
                value={value.queenHealth}
                onChange={(event) => set("queenHealth", event.target.value)}
                placeholder="Laying well, marked"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor={id("brood")}>Brood pattern</Label>
                <Select
                  value={value.broodPattern || UNSET}
                  onValueChange={(next) =>
                    set("broodPattern", next === UNSET ? "" : next)
                  }
                >
                  <SelectTrigger id={id("brood")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNSET}>Not recorded</SelectItem>
                    {broodOptions.map((pattern) => (
                      <SelectItem key={pattern} value={pattern} className="capitalize">
                        {pattern}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <RatingSelect
                id={id("honey")}
                label="Honey stores"
                value={value.storesHoney}
                onChange={(next) => set("storesHoney", next)}
                labels={STORES_LABELS}
              />
              <RatingSelect
                id={id("pollen")}
                label="Pollen stores"
                value={value.storesPollen}
                onChange={(next) => set("storesPollen", next)}
                labels={STORES_LABELS}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  ["framesOfBees", "Frames of bees"],
                  ["framesOfBrood", "Frames of brood"],
                  ["framesOfStores", "Frames of stores"],
                ] as const
              ).map(([name, label]) => (
                <div key={name} className="grid gap-1.5">
                  <Label htmlFor={id(name)}>{label}</Label>
                  <Input
                    id={id(name)}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={value[name]}
                    onChange={(event) => set(name, event.target.value)}
                    {...invalid(name)}
                  />
                  <FieldError id={id(`${name}-error`)} message={errors[name]} />
                </div>
              ))}
            </div>

            <div className="grid gap-2">
              <ListHeader
                title="More mite counts"
                addLabel="Add count"
                onAdd={() => {
                  const used = new Set(value.miteCounts.map((row) => row.method));
                  const next =
                    MITE_METHODS.find((item) => !used.has(item.value))?.value ??
                    "alcohol_wash";
                  set("miteCounts", [
                    ...(value.miteCounts.length === 0 ? [emptyMiteRow()] : value.miteCounts),
                    emptyMiteRow(next),
                  ]);
                }}
              />
              {value.miteCounts.slice(1).map((row, offset) => {
                const index = offset + 1;
                const board = isBoardMiteMethod(row.method);
                return (
                  <div
                    key={index}
                    className="grid grid-cols-2 items-end gap-2 rounded-md border p-2 sm:grid-cols-[1.3fr_1fr_1fr_auto]"
                  >
                    <div className="col-span-2 grid gap-1 sm:col-span-1">
                      <Label htmlFor={id(`mite-${index}-method`)} className="text-xs">
                        Method
                      </Label>
                      <Select
                        value={row.method}
                        onValueChange={(next) =>
                          setMite(index, { method: next as MiteMethod })
                        }
                      >
                        <SelectTrigger
                          id={id(`mite-${index}-method`)}
                          {...invalid(`miteCounts.${index}.method`)}
                        >
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
                    <div className="grid gap-1">
                      <Label htmlFor={id(`mite-${index}-count`)} className="text-xs">
                        Mites found
                      </Label>
                      <Input
                        id={id(`mite-${index}-count`)}
                        type="number"
                        inputMode="numeric"
                        min="0"
                        step="1"
                        value={row.mitesCount}
                        onChange={(event) =>
                          setMite(index, { mitesCount: event.target.value })
                        }
                        {...invalid(`miteCounts.${index}.mitesCount`)}
                      />
                    </div>
                    {board ? (
                      include.daysOnBoard ? (
                        <div className="grid gap-1">
                          <Label htmlFor={id(`mite-${index}-days`)} className="text-xs">
                            Days on board
                          </Label>
                          <Input
                            id={id(`mite-${index}-days`)}
                            type="number"
                            inputMode="numeric"
                            min="1"
                            step="1"
                            value={row.daysOnBoard}
                            onChange={(event) =>
                              setMite(index, { daysOnBoard: event.target.value })
                            }
                            {...invalid(`miteCounts.${index}.daysOnBoard`)}
                          />
                        </div>
                      ) : (
                        <span />
                      )
                    ) : (
                      <div className="grid gap-1">
                        <Label htmlFor={id(`mite-${index}-sample`)} className="text-xs">
                          Bees sampled
                        </Label>
                        <Input
                          id={id(`mite-${index}-sample`)}
                          type="number"
                          inputMode="numeric"
                          min="1"
                          step="1"
                          value={row.sampleSize}
                          onChange={(event) =>
                            setMite(index, { sampleSize: event.target.value })
                          }
                          {...invalid(`miteCounts.${index}.sampleSize`)}
                        />
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${miteMethodLabel(row.method).toLowerCase()} count`}
                      onClick={() =>
                        set(
                          "miteCounts",
                          value.miteCounts.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                    <div className="col-span-full grid gap-1">
                      {(["method", "mitesCount", "sampleSize", "daysOnBoard"] as const).map(
                        (field) => (
                          <FieldError
                            key={field}
                            id={id(`miteCounts.${index}.${field}-error`)}
                            message={errors[`miteCounts.${index}.${field}`]}
                          />
                        ),
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {include.feedingsAndQueenEvents ? (
              <>
                <div className="grid gap-2">
                  <ListHeader
                    title="Feeding"
                    addLabel="Add feeding"
                    onAdd={() =>
                      set("feedings", [
                        ...value.feedings,
                        {
                          type: "sugar_syrup_1to1",
                          quantity: "",
                          quantityUnit: "gallons",
                          feederType: "other",
                          notes: "",
                        },
                      ])
                    }
                  />
                  {value.feedings.map((feeding, index) => {
                    const update = (patch: Partial<typeof feeding>) =>
                      set(
                        "feedings",
                        value.feedings.map((item, i) =>
                          i === index ? { ...item, ...patch } : item,
                        ),
                      );
                    return (
                      <div
                        key={index}
                        className="grid grid-cols-2 items-end gap-2 rounded-md border p-2 sm:grid-cols-[1.3fr_0.8fr_1fr_1.2fr_auto]"
                      >
                        <div className="col-span-2 grid gap-1 sm:col-span-1">
                          <Label htmlFor={id(`feed-${index}-type`)} className="text-xs">
                            Feed
                          </Label>
                          <Select
                            value={feeding.type}
                            onValueChange={(next) => update({ type: next as FeedingType })}
                          >
                            <SelectTrigger id={id(`feed-${index}-type`)}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {FEEDING_TYPE_LABELS.map(([type, label]) => (
                                <SelectItem key={type} value={type}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={id(`feed-${index}-qty`)} className="text-xs">
                            Amount
                          </Label>
                          <Input
                            id={id(`feed-${index}-qty`)}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.1"
                            value={feeding.quantity}
                            onChange={(event) => update({ quantity: event.target.value })}
                            {...invalid(`feedings.${index}.quantity`)}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={id(`feed-${index}-unit`)} className="text-xs">
                            Unit
                          </Label>
                          <Select
                            value={feeding.quantityUnit}
                            onValueChange={(next) =>
                              update({ quantityUnit: next as QuantityUnit })
                            }
                          >
                            <SelectTrigger id={id(`feed-${index}-unit`)}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {QUANTITY_UNITS.map((unit) => (
                                <SelectItem key={unit} value={unit}>
                                  {unit}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={id(`feed-${index}-feeder`)} className="text-xs">
                            Feeder
                          </Label>
                          <Select
                            value={feeding.feederType}
                            onValueChange={(next) =>
                              update({ feederType: next as FeederType })
                            }
                          >
                            <SelectTrigger id={id(`feed-${index}-feeder`)}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {FEEDER_LABELS.map(([type, label]) => (
                                <SelectItem key={type} value={type}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove feeding ${index + 1}`}
                          onClick={() =>
                            set(
                              "feedings",
                              value.feedings.filter((_, i) => i !== index),
                            )
                          }
                        >
                          <Trash2 />
                        </Button>
                        <div className="col-span-full">
                          <FieldError
                            id={id(`feedings.${index}.quantity-error`)}
                            message={errors[`feedings.${index}.quantity`]}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="grid gap-2">
                  <ListHeader
                    title="Queen events"
                    addLabel="Add event"
                    onAdd={() =>
                      set("queenEvents", [
                        ...value.queenEvents,
                        { eventType: "observed", notes: "" },
                      ])
                    }
                  />
                  {value.queenEvents.map((event, index) => {
                    const update = (patch: Partial<typeof event>) =>
                      set(
                        "queenEvents",
                        value.queenEvents.map((item, i) =>
                          i === index ? { ...item, ...patch } : item,
                        ),
                      );
                    return (
                      <div
                        key={index}
                        className="grid grid-cols-[1fr_auto] items-end gap-2 sm:grid-cols-[1fr_1.5fr_auto]"
                      >
                        <div className="grid gap-1">
                          <Label htmlFor={id(`queen-event-${index}`)} className="text-xs">
                            Event
                          </Label>
                          <Select
                            value={event.eventType}
                            onValueChange={(next) =>
                              update({ eventType: next as QueenEventType })
                            }
                          >
                            <SelectTrigger id={id(`queen-event-${index}`)}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(QUEEN_EVENT_LABELS) as QueenEventType[]).map(
                                (kind) => (
                                  <SelectItem key={kind} value={kind}>
                                    {QUEEN_EVENT_LABELS[kind]}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="sm:order-last"
                          aria-label={`Remove queen event ${index + 1}`}
                          onClick={() =>
                            set(
                              "queenEvents",
                              value.queenEvents.filter((_, i) => i !== index),
                            )
                          }
                        >
                          <Trash2 />
                        </Button>
                        <div className="col-span-2 grid gap-1 sm:col-span-1">
                          <Label
                            htmlFor={id(`queen-event-${index}-notes`)}
                            className="text-xs"
                          >
                            Event note
                          </Label>
                          <Input
                            id={id(`queen-event-${index}-notes`)}
                            value={event.notes}
                            onChange={(change) => update({ notes: change.target.value })}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}

            <div className="grid gap-2">
              <ListHeader
                title="Pests"
                addLabel="Add pest"
                onAdd={() => set("pests", [...value.pests, { type: "", count: "" }])}
              />
              {value.pests.map((pest, index) => {
                const update = (patch: Partial<typeof pest>) =>
                  set(
                    "pests",
                    value.pests.map((item, i) => (i === index ? { ...item, ...patch } : item)),
                  );
                return (
                  <div key={index} className="grid gap-1">
                    <div className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
                      <div className="grid gap-1">
                        <Label htmlFor={id(`pest-${index}-type`)} className="text-xs">
                          Pest
                        </Label>
                        <Input
                          id={id(`pest-${index}-type`)}
                          value={pest.type}
                          onChange={(event) => update({ type: event.target.value })}
                          placeholder="Small hive beetle"
                          {...invalid(`pests.${index}.type`)}
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor={id(`pest-${index}-count`)} className="text-xs">
                          How many
                        </Label>
                        <Input
                          id={id(`pest-${index}-count`)}
                          value={pest.count}
                          onChange={(event) => update({ count: event.target.value })}
                          placeholder="A few"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove pest ${index + 1}`}
                        onClick={() =>
                          set("pests", value.pests.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <FieldError
                      id={id(`pests.${index}.type-error`)}
                      message={errors[`pests.${index}.type`]}
                    />
                  </div>
                );
              })}
            </div>

            <div className="grid gap-2">
              <ListHeader
                title="Treatments"
                addLabel="Add treatment"
                onAdd={() =>
                  set("treatments", [...value.treatments, { product: "", method: "" }])
                }
              />
              {value.treatments.map((treatment, index) => {
                const update = (patch: Partial<typeof treatment>) =>
                  set(
                    "treatments",
                    value.treatments.map((item, i) =>
                      i === index ? { ...item, ...patch } : item,
                    ),
                  );
                return (
                  <div key={index} className="grid gap-1">
                    <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                      <div className="grid gap-1">
                        <Label htmlFor={id(`treatment-${index}-product`)} className="text-xs">
                          Product
                        </Label>
                        <Input
                          id={id(`treatment-${index}-product`)}
                          value={treatment.product}
                          onChange={(event) => update({ product: event.target.value })}
                          placeholder="Oxalic acid"
                          {...invalid(`treatments.${index}.product`)}
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor={id(`treatment-${index}-method`)} className="text-xs">
                          Method
                        </Label>
                        <Input
                          id={id(`treatment-${index}-method`)}
                          value={treatment.method}
                          onChange={(event) => update({ method: event.target.value })}
                          placeholder="Vaporization"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove treatment ${index + 1}`}
                        onClick={() =>
                          set(
                            "treatments",
                            value.treatments.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <FieldError
                      id={id(`treatments.${index}.product-error`)}
                      message={errors[`treatments.${index}.product`]}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}
