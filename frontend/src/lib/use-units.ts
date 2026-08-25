"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

import {
  formatElevation,
  formatFeeding,
  formatHoneyMass,
  formatPropolisMass,
  formatTemperatureC,
  formatWindKmh,
  parseFeedingQuantity,
  parseMass,
  preferredMassSuffix,
  resolveUnitsPreference,
  type UnitsPreference,
} from "./units";

type PrefsSlice = {
  units?: string | null;
  temperatureUnit?: string | null;
};

/**
 * Operator display units. Unset preference falls back to the browser locale.
 * Honey Story / labels should call resolveUnitsPreference with the stored
 * operator value, not the viewer's locale.
 */
export function useUnits(): UnitsPreference & {
  formatHoney: (pounds: number | null | undefined) => string;
  formatHoneyDual: (pounds: number | null | undefined) => string;
  formatPropolis: (grams: number | null | undefined) => string;
  formatElevation: (meters: number | null | undefined) => string;
  formatTemperature: (celsius: number | null | undefined) => string;
  formatWind: (kmh: number | null | undefined) => string;
  formatFeeding: (
    quantity: number | null | undefined,
    unit: string | null | undefined,
  ) => string;
  parseMassToPounds: (raw: string) => number | null;
  parseMassToGrams: (raw: string) => number | null;
  parseFeeding: (raw: string) => ReturnType<typeof parseFeedingQuantity>;
  honeySuffix: string;
  propolisSuffix: string;
  ready: boolean;
} {
  const prefs = useQuery({
    queryKey: ["ops", "units"],
    queryFn: () => api.get<PrefsSlice>("/ops/units"),
  });
  const resolved = useMemo(
    () =>
      resolveUnitsPreference({
        units: prefs.data?.units,
        temperatureUnit: prefs.data?.temperatureUnit,
      }),
    [prefs.data?.units, prefs.data?.temperatureUnit],
  );

  return useMemo(() => {
    const { units, temperature } = resolved;
    return {
      ...resolved,
      formatHoney: (pounds: number | null | undefined) =>
        formatHoneyMass(pounds, units)?.text ?? "",
      formatHoneyDual: (pounds: number | null | undefined) =>
        formatHoneyMass(pounds, units)?.dual ?? "",
      formatPropolis: (grams: number | null | undefined) =>
        formatPropolisMass(grams, units)?.text ?? "",
      formatElevation: (meters: number | null | undefined) =>
        formatElevation(meters, units)?.text ?? "",
      formatTemperature: (celsius: number | null | undefined) =>
        formatTemperatureC(celsius, temperature)?.text ?? "",
      formatWind: (kmh: number | null | undefined) =>
        formatWindKmh(kmh, units)?.text ?? "",
      formatFeeding: (
        quantity: number | null | undefined,
        unit: string | null | undefined,
      ) => formatFeeding(quantity, unit, units)?.text ?? "",
      parseMassToPounds: (raw: string) => parseMass(raw, "pounds")?.pounds ?? null,
      parseMassToGrams: (raw: string) => parseMass(raw, "grams")?.grams ?? null,
      parseFeeding: (raw: string) => parseFeedingQuantity(raw, units),
      honeySuffix: preferredMassSuffix(units, "honey"),
      propolisSuffix: preferredMassSuffix(units, "propolis"),
      ready: prefs.isSuccess,
    };
  }, [prefs.isSuccess, resolved]);
}
