"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiaryOptions } from "@/features/settings/api";

import {
  detectLocaleUnits,
  formatElevation,
  formatHoneyMass,
  formatPropolisMass,
  formatTemperatureC,
  resolveUnitsPreference,
} from "@/lib/units";

import {
  ME_PREFERENCES_KEY,
  useMePreferences,
  useUpdateMePreferences,
  type MePreferences,
  type MePreferencesPayload,
} from "./api";

const NONE = "none";

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const DATE_FORMATS = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"];

const WEIGHT_UNITS = [
  { value: "oz", label: "Ounces (oz)" },
  { value: "lbs", label: "Pounds (lbs)" },
  { value: "g", label: "Grams (g)" },
  { value: "kg", label: "Kilograms (kg)" },
];

const UNIT_SYSTEMS = [
  { value: "metric", label: "Metric (kg, g, m, °C)" },
  { value: "us", label: "US (lb, oz, ft, °F)" },
] as const;

const TEMPERATURE_UNITS = [
  { value: "follow", label: "Match units" },
  { value: "c", label: "Celsius (°C)" },
  { value: "f", label: "Fahrenheit (°F)" },
] as const;

function PreferenceField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/**
 * The six per-user columns of `user_preferences` (design 2026-09-03 §6.4) and
 * nothing else: the mite and moisture thresholds and the labor flag this form
 * used to carry are operation policy and live in Operation Setup now.
 */
export function MePreferencesForm() {
  const prefs = useMePreferences();
  const apiaries = useApiaryOptions();
  const updatePrefs = useUpdateMePreferences();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();

  // On load the API value is the single source of truth: push it into
  // next-themes once so both stores agree (the legacy app kept two diverging
  // theme stores).
  const syncedRef = React.useRef(false);
  React.useEffect(() => {
    if (prefs.data && !syncedRef.current) {
      syncedRef.current = true;
      setTheme(prefs.data.theme);
    }
  }, [prefs.data, setTheme]);

  function save(patch: Partial<MePreferencesPayload>) {
    const current = prefs.data;
    if (!current) return;
    const payload: MePreferencesPayload = {
      theme: current.theme,
      defaultApiaryId: current.defaultApiaryId,
      dateFormat: current.dateFormat,
      weightUnit: current.weightUnit,
      units: current.units,
      temperatureUnit: current.temperatureUnit,
      ...patch,
    };
    // Optimistic cache write so the selects don't snap back while saving.
    queryClient.setQueryData<MePreferences>(ME_PREFERENCES_KEY, {
      ...current,
      ...patch,
      temperatureUnit:
        patch.temperatureUnit === ""
          ? null
          : (patch.temperatureUnit ?? current.temperatureUnit),
    });
    updatePrefs.mutate(payload, {
      onSuccess: () => toast.success("Preferences saved"),
      onError: (error) => {
        queryClient.setQueryData(ME_PREFERENCES_KEY, current);
        if (patch.theme) setTheme(current.theme);
        toast.error(
          error instanceof ApiError
            ? error.message
            : "Could not save preferences",
        );
      },
    });
  }

  if (prefs.isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (prefs.isError || !prefs.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load preferences.{" "}
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => prefs.refetch()}
        >
          Try again
        </button>
      </p>
    );
  }

  const data = prefs.data;
  const localeDefault = detectLocaleUnits();
  const unitsValue = data.units ?? localeDefault;
  const resolved = resolveUnitsPreference({
    units: data.units ?? localeDefault,
    temperatureUnit: data.temperatureUnit,
  });
  const honeyPreview = formatHoneyMass(1, resolved.units);
  const elevationPreview = formatElevation(640, resolved.units);
  const tempPreview = formatTemperatureC(10, resolved.temperature);
  const propolisPreview = formatPropolisMass(28.35, resolved.units);

  return (
    <div className="grid gap-4 sm:grid-cols-2" data-config-editor="preferences">
      <PreferenceField label="Theme" htmlFor="pref-theme">
        <Select
          value={data.theme}
          onValueChange={(value) => {
            // Write both stores: next-themes for instant paint, the API for
            // persistence across devices — this account's, not the operation's.
            setTheme(value);
            save({ theme: value });
          }}
        >
          <SelectTrigger id="pref-theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEMES.map((theme) => (
              <SelectItem key={theme.value} value={theme.value}>
                {theme.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PreferenceField>

      <PreferenceField label="Default apiary" htmlFor="pref-apiary">
        <Select
          value={data.defaultApiaryId ?? NONE}
          onValueChange={(value) =>
            save({ defaultApiaryId: value === NONE ? null : value })
          }
        >
          <SelectTrigger id="pref-apiary">
            <SelectValue placeholder="No default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No default</SelectItem>
            {(apiaries.data ?? []).map((apiary) => (
              <SelectItem key={apiary.id} value={apiary.id}>
                {apiary.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PreferenceField>

      <PreferenceField label="Date format" htmlFor="pref-date-format">
        <Select
          value={data.dateFormat}
          onValueChange={(value) => save({ dateFormat: value })}
        >
          <SelectTrigger id="pref-date-format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_FORMATS.map((format) => (
              <SelectItem key={format} value={format}>
                {format}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PreferenceField>

      <PreferenceField label="Units" htmlFor="pref-units">
        <Select
          value={unitsValue}
          onValueChange={(value) =>
            save({ units: value === "metric" ? "metric" : "us" })
          }
        >
          <SelectTrigger id="pref-units">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UNIT_SYSTEMS.map((system) => (
              <SelectItem key={system.value} value={system.value}>
                {system.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!data.units ? (
          <p className="text-xs text-muted-foreground">
            Defaulted from this browser (
            {localeDefault === "us" ? "US" : "metric"}). Saving stores it for
            Honey Story and labels too.
          </p>
        ) : null}
      </PreferenceField>

      <PreferenceField label="Temperature" htmlFor="pref-temperature">
        <Select
          value={data.temperatureUnit ?? "follow"}
          onValueChange={(value) =>
            save({
              temperatureUnit: value === "c" || value === "f" ? value : "",
            })
          }
        >
          <SelectTrigger id="pref-temperature">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEMPERATURE_UNITS.map((unit) => (
              <SelectItem key={unit.value} value={unit.value}>
                {unit.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PreferenceField>

      <PreferenceField label="Jar weight unit" htmlFor="pref-weight-unit">
        <Select
          value={data.weightUnit}
          onValueChange={(value) => save({ weightUnit: value })}
        >
          <SelectTrigger id="pref-weight-unit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WEIGHT_UNITS.map((unit) => (
              <SelectItem key={unit.value} value={unit.value}>
                {unit.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PreferenceField>

      <div className="rounded-lg border bg-muted/40 p-3 text-sm sm:col-span-2">
        <p className="font-medium">Display preview</p>
        <p className="mt-1 text-muted-foreground">
          Honey {honeyPreview?.dual} · elevation {elevationPreview?.dual} ·{" "}
          {tempPreview?.dual} · propolis {propolisPreview?.dual}. Typed inputs
          like <span className="font-mono">2 kg</span> or{" "}
          <span className="font-mono">4.4 lb</span> convert to the stored unit.
        </p>
      </div>
    </div>
  );
}
