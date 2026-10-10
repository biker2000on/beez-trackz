"use client";

/**
 * One season-year picker for the whole app.
 *
 * The years offered run from the earliest year the operator has anything
 * recorded (`GET /meta/years`) through the current year, newest first, with
 * optional years ahead for things that are planned. A value outside that span
 * (an old URL, a record dated before everything else) is still listed, so a
 * picker never silently changes what it shows.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** GET /api/v1/meta/years */
export interface MetaYears {
  min: number;
  max: number;
  current: number;
}

/** Used when the span cannot be loaded (offline, older API, a mock). */
export const FALLBACK_EARLIEST_YEAR = 2020;

const ALL = "__all__";
const NONE = "__none__";

function isYear(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2200;
}

/** The operator's span of season years; tolerant of a missing or odd answer. */
export function useYearSpan(): { min: number; max: number } {
  const current = new Date().getFullYear();
  const query = useQuery({
    queryKey: ["meta", "years"],
    queryFn: () => api.get<MetaYears>("/meta/years"),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const data = query.data as Partial<MetaYears> | undefined;
  const dataMin = data?.min;
  const dataMax = data?.max;
  const min = isYear(dataMin) ? Math.min(dataMin, current) : FALLBACK_EARLIEST_YEAR;
  const max = isYear(dataMax) ? Math.max(dataMax, current) : current;
  return { min: Math.min(min, max), max };
}

/** Years to list, newest first. Exported for tests and other pickers. */
export function yearOptions({
  min,
  max,
  ahead = 0,
  earliest,
  value,
}: {
  min: number;
  max: number;
  ahead?: number;
  earliest?: number;
  value?: number | null;
}): number[] {
  const current = new Date().getFullYear();
  const top = Math.max(max, current + ahead);
  const bottom = earliest != null ? Math.min(min, earliest) : min;
  const years = new Set<number>();
  for (let year = top; year >= bottom; year -= 1) years.add(year);
  if (value != null && Number.isFinite(value)) years.add(value);
  return [...years].sort((a, b) => b - a);
}

export interface YearSelectProps {
  /** The chosen year; `null` means "All years" / not set. */
  value: number | null | undefined;
  onValueChange: (year: number | null) => void;
  /** Filter use: offer an "All years" choice that maps to `null`. */
  allowAll?: boolean;
  allLabel?: string;
  /** Optional form field: offer a "not set" choice that maps to `null`. */
  allowNone?: boolean;
  noneLabel?: string;
  /** Years past the current one to offer, for things planned ahead. */
  ahead?: number;
  /** Reach back at least this far, even before the operator's data starts. */
  earliest?: number;
  placeholder?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

export function YearSelect({
  value,
  onValueChange,
  allowAll = false,
  allLabel = "All years",
  allowNone = false,
  noneLabel = "Not set",
  ahead = 0,
  earliest,
  placeholder = "Year",
  id,
  className,
  disabled,
  "aria-label": ariaLabel,
}: YearSelectProps) {
  const { min, max } = useYearSpan();
  const years = React.useMemo(
    () => yearOptions({ min, max, ahead, earliest, value }),
    [min, max, ahead, earliest, value],
  );
  const selected =
    value != null && Number.isFinite(value)
      ? String(value)
      : allowAll
        ? ALL
        : allowNone
          ? NONE
          : "";

  return (
    <Select
      value={selected}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === ALL || next === NONE) onValueChange(null);
        else onValueChange(Number(next));
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={cn("w-28 tabular-nums", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowAll && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {allowNone && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {years.map((year) => (
          <SelectItem key={year} value={String(year)} className="tabular-nums">
            {year}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
