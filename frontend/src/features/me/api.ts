"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * My Preferences — the per-user half of the old singleton settings row
 * (design 2026-09-03 §6.1, §6.4).
 *
 * `GET`/`PUT /api/v1/me/preferences` is available to every authenticated
 * user and touches only `user_preferences`, the table keyed by
 * `app_users.id`. Operation-wide policy and secrets (thresholds, the labor
 * flag, ntfy, AI keys) stay on `user_settings` behind
 * `/api/v1/admin/policy` — see `@/features/admin/api`.
 */
export interface MePreferences {
  theme: string;
  defaultApiaryId: string | null;
  dateFormat: string;
  weightUnit: string;
  /** null until the user picks one; the form falls back to the browser locale. */
  units: "metric" | "us" | null;
  temperatureUnit: "c" | "f" | null;
}

/** Send "" for temperatureUnit to clear it back to "follow units". */
export interface MePreferencesPayload {
  theme: string;
  defaultApiaryId: string | null;
  dateFormat: string;
  weightUnit: string;
  units?: "metric" | "us" | null;
  temperatureUnit?: "c" | "f" | "" | null;
}

export const ME_PREFERENCES_KEY = ["me", "preferences"] as const;

export function useMePreferences(enabled = true) {
  return useQuery({
    queryKey: ME_PREFERENCES_KEY,
    queryFn: () => api.get<MePreferences>("/me/preferences"),
    enabled,
  });
}

export function useUpdateMePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: MePreferencesPayload) =>
      api.put<{ success: boolean }>("/me/preferences", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ME_PREFERENCES_KEY });
      // Units and temperature are read by every formatter through
      // GET /ops/units, which now answers per user.
      queryClient.invalidateQueries({ queryKey: ["ops"] });
    },
  });
}
