"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Operation policy — the half of the old singleton settings row that is not
 * anybody's personal preference (design 2026-09-03 §6.2, §6.3, §6.4).
 *
 * `GET`/`PUT /api/v1/admin/policy` is admin-only and edits `user_settings`:
 * the mite and moisture thresholds the recommendation engine reads, the
 * yard-visit labor enable flag, and the ntfy webhook (whose access token is
 * never returned, only `hasAccessToken`). Per-user display preferences moved
 * to `/api/v1/me/preferences` — see `@/features/me/api`.
 *
 * The provider integrations keep their own routes (`/settings/ai`,
 * `/settings/gnucash`, `/settings/storage`, `/ops/ntfy/*`).
 */

export const NTFY_EVENT_KINDS = [
  "mite_check_due",
  "feeder_empty",
  "treatment_off_date",
  "flow_started",
] as const;
export type NtfyEventKind = (typeof NTFY_EVENT_KINDS)[number];

export const NTFY_EVENT_LABELS: Record<NtfyEventKind, string> = {
  mite_check_due: "Mite check due",
  feeder_empty: "Feeder empty",
  treatment_off_date: "Treatment off-date",
  flow_started: "Flow started",
};

export interface NtfySettings {
  serverUrl: string;
  topic: string;
  /** Whether a token is stored. The token itself is never returned (same
   * masked pattern as AISettings.apiKeys). */
  hasAccessToken?: boolean;
  enabled: boolean;
  eventKinds: NtfyEventKind[];
}

/** Omit accessToken to keep the stored one, send "" to clear it. */
export type NtfyPayload = Omit<NtfySettings, "hasAccessToken"> & {
  accessToken?: string;
};

export interface OperationPolicy {
  laborTrackingEnabled: boolean;
  miteThresholdPer100: number | null;
  miteThresholdPerDay: number | null;
  miteCheckIntervalDays: number | null;
  moistureThresholdPct: number | null;
  ntfy: NtfySettings;
}

/** Every field is optional: an omitted field keeps its stored value. */
export interface OperationPolicyPayload {
  laborTrackingEnabled?: boolean;
  miteThresholdPer100?: number | null;
  miteThresholdPerDay?: number | null;
  miteCheckIntervalDays?: number | null;
  moistureThresholdPct?: number | null;
  ntfy?: NtfyPayload;
}

export const OPERATION_POLICY_KEY = ["admin", "policy"] as const;

export function useOperationPolicy(enabled = true) {
  return useQuery({
    queryKey: OPERATION_POLICY_KEY,
    queryFn: () => api.get<OperationPolicy>("/admin/policy"),
    enabled,
  });
}

export function useUpdateOperationPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: OperationPolicyPayload) =>
      api.put<{ success: boolean }>("/admin/policy", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: OPERATION_POLICY_KEY });
      // The labor widget on /yard/queue reads its enabled flag from the ops
      // group.
      queryClient.invalidateQueries({ queryKey: ["ops"] });
    },
  });
}

export function useTestNtfy() {
  return useMutation({
    mutationFn: () =>
      api.post<{ success?: boolean; error?: string }>("/ops/ntfy/test"),
  });
}

export function useDispatchNtfy() {
  return useMutation({
    mutationFn: () =>
      api.post<{
        published: number;
        skipped: number;
        errors: string[];
        reason?: string;
      }>("/ops/ntfy/dispatch"),
  });
}
