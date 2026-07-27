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
  usePreferences,
  useUpdatePreferences,
  type Preferences,
} from "@/features/settings/api";
import { useAccessProfile } from "@/features/access/api";

export function ThemeToggle() {
  const { setTheme } = useTheme();
  const profile = useAccessProfile();
  const isAdmin = profile.data?.isAdmin === true;
  const prefs = usePreferences(isAdmin);
  const updatePrefs = useUpdatePreferences();
  const queryClient = useQueryClient();

  // Persist theme changes to the API too — the Settings page treats the API
  // value as the source of truth on load, so a toggle that only touched
  // next-themes would get silently reverted the next time Settings mounts.
  function choose(theme: "light" | "dark" | "system") {
    setTheme(theme);
    const current = isAdmin ? prefs.data : undefined;
    if (!current || current.theme === theme) return;
    queryClient.setQueryData<Preferences>(["settings", "preferences"], {
      ...current,
      theme,
    });
    updatePrefs.mutate({
      theme,
      defaultApiaryId: current.defaultApiaryId,
      dateFormat: current.dateFormat,
      weightUnit: current.weightUnit,
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
