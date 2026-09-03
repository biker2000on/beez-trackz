"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { MonitorSmartphone, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ME_PREFERENCES_KEY,
  useMePreferences,
  useUpdateMePreferences,
  type MePreferences,
} from "@/features/me/api";

export function ThemeToggle() {
  const { setTheme } = useTheme();
  // Every authenticated user has preferences of their own now (design
  // 2026-09-03 §6.4), so the toggle no longer asks whether you are an admin
  // before it is allowed to remember your theme.
  const prefs = useMePreferences();
  const updatePrefs = useUpdateMePreferences();
  const queryClient = useQueryClient();

  // Persist theme changes to the API too — My preferences treats the API
  // value as the source of truth on load, so a toggle that only touched
  // next-themes would get silently reverted the next time it mounts.
  function choose(theme: "light" | "dark" | "system") {
    setTheme(theme);
    const current = prefs.data;
    if (!current || current.theme === theme) return;
    queryClient.setQueryData<MePreferences>(ME_PREFERENCES_KEY, {
      ...current,
      theme,
    });
    updatePrefs.mutate({
      theme,
      defaultApiaryId: current.defaultApiaryId,
      dateFormat: current.dateFormat,
      weightUnit: current.weightUnit,
      units: current.units,
      temperatureUnit: current.temperatureUnit,
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme">
          <Sun className="size-4 scale-100 rotate-0 transition-transform dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute size-4 scale-0 rotate-90 transition-transform dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => choose("light")}>
          <Sun /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose("dark")}>
          <Moon /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose("system")}>
          <MonitorSmartphone /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
