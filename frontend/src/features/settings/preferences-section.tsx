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

import {
  useApiaryOptions,
  usePreferences,
  useUpdatePreferences,
  type Preferences,
  type PreferencesPayload,
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

export function PreferencesSection() {
  const prefs = usePreferences();
  const apiaries = useApiaryOptions();
  const updatePrefs = useUpdatePreferences();
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

  function save(patch: Partial<PreferencesPayload>) {
    const current = prefs.data;
    if (!current) return;
    const payload: PreferencesPayload = {
      theme: current.theme,
      defaultApiaryId: current.defaultApiaryId,
      dateFormat: current.dateFormat,
      weightUnit: current.weightUnit,
      ...patch,
    };
    // Optimistic cache write so the selects don't snap back while saving.
    queryClient.setQueryData<Preferences>(["settings", "preferences"], {
      ...current,
      ...patch,
    });
    updatePrefs.mutate(payload, {
      onSuccess: () => toast.success("Preferences saved"),
      onError: (error) => {
        queryClient.setQueryData(["settings", "preferences"], current);
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

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <PreferenceField label="Theme" htmlFor="pref-theme">
        <Select
          value={data.theme}
          onValueChange={(value) => {
            // Write both stores: next-themes for instant paint, the API for
            // persistence across devices.
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

      <PreferenceField label="Weight unit" htmlFor="pref-weight-unit">
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
    </div>
  );
}
