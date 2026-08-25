"use client";

/**
 * Per-jar-line provenance picker: which bottling run filled these jars.
 *
 * The API accepts an optional `bottlingRunId` on every jar sale line
 * (migration 00038). The run pins the jar size and resolves to exactly one
 * harvest lot, which is what lets the treatment-withdrawal lockout refuse a
 * jar sale that names no lot of its own. Leaving it unset stays legal — old
 * sales and quick market-day checkouts carry no provenance.
 *
 * Kept standalone so the jar-line editor can drop it into a line row without
 * taking on the lot query itself.
 */

import * as React from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate } from "@/features/honey/format";

import { useHarvestLots, type HarvestLot } from "./api";

export interface BottlingRunOption {
  runId: string;
  lotId: string;
  lotCode: string;
  jarSizeId: string;
  bottledDate: string;
  quantity: number;
  /** The lot is inside a treatment withdrawal window; the API will refuse it. */
  locked: boolean;
}

/** Flatten every lot's live bottling runs into one selectable list. */
export function bottlingRunOptions(
  lots: HarvestLot[] | undefined,
  jarSizeId?: string,
): BottlingRunOption[] {
  return (lots ?? [])
    .flatMap((lot) =>
      // The API already drops voided runs from this list, and a run with no
      // jar size never entered inventory, so neither can be sold from.
      lot.bottlingRuns
        .filter((run) => run.jarSizeId != null)
        .map((run) => ({
          runId: run.id,
          lotId: lot.id,
          lotCode: lot.lotCode,
          jarSizeId: run.jarSizeId as string,
          bottledDate: run.bottledDate,
          quantity: run.quantity,
          locked: lot.lockout?.locked ?? false,
        })),
    )
    .filter((option) => !jarSizeId || option.jarSizeId === jarSizeId)
    .sort((a, b) => b.bottledDate.localeCompare(a.bottledDate));
}

export function describeBottlingRun(option: BottlingRunOption): string {
  return `${option.lotCode} · ${formatDate(option.bottledDate)} · ${option.quantity} jars`;
}

const NO_RUN = "none";

export function BottlingRunPicker({
  jarSizeId,
  value,
  onChange,
  disabled = false,
  label = "Lot (bottling run)",
}: {
  /** Only runs that filled this size are offered; the API enforces the match. */
  jarSizeId: string;
  value: string | undefined;
  onChange: (runId: string | undefined) => void;
  disabled?: boolean;
  label?: string;
}) {
  const lots = useHarvestLots();
  const options = React.useMemo(
    () => bottlingRunOptions(lots.data, jarSizeId),
    [lots.data, jarSizeId],
  );
  const id = React.useId();

  if (options.length === 0) return null;

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select
        value={value ?? NO_RUN}
        onValueChange={(next) => onChange(next === NO_RUN ? undefined : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder="Not traced" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_RUN}>Not traced</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.runId} value={option.runId}>
              {describeBottlingRun(option)}
              {/* Shown rather than hidden: the operator needs to know why the
                  jars they are holding cannot be sold. */}
              {option.locked ? " · locked" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
