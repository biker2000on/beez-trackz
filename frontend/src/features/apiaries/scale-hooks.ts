"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api } from "@/lib/api";

// Scale hives. CSV ingest only (Broodminder / HiveTracks exports) — no MQTT.
// One scale per yard is enough, so the hive link is optional.
// Mirrors backend/internal/httpapi/routes_scale.go.

export type ScaleVendor = "broodminder" | "hivetracks" | "other";

export const SCALE_VENDOR_LABELS: Record<ScaleVendor, string> = {
  broodminder: "Broodminder",
  hivetracks: "HiveTracks",
  other: "Other / generic CSV",
};

export interface YardScale {
  id: string;
  apiaryId: string;
  hiveId: string | null;
  hiveLabel: string | null;
  name: string;
  vendor: ScaleVendor;
  deviceId: string | null;
  notes: string | null;
  readingCount: number;
  firstReading: string | null;
  lastReading: string | null;
  lastWeightLb: number | null;
  createdAt: string;
}

export interface ScalePoint {
  date: string;
  weightLb: number;
  minLb: number | null;
  maxLb: number | null;
  /** Day-over-day change: the flow, or the robbing event. */
  changeLb: number | null;
  temperatureF: number | null;
}

export interface ScaleSeries {
  scaleId: string;
  name: string;
  vendor: ScaleVendor;
  hiveId: string | null;
  hiveLabel: string | null;
  points: ScalePoint[];
  /** The last day read the way the yard reads it: gained, lost, or flat. */
  latestSummary: string;
}

export interface ScaleSeriesResponse {
  apiaryId: string;
  from: string;
  to: string;
  scales: ScaleSeries[];
  /** Bloom windows overlaid behind the weight curve. */
  blooms: Array<{
    species: string;
    elevationBand: string | null;
    firstSeen: string;
    lastSeen: string | null;
  }>;
  /** Inspection dates, so a dip can be read as "I pulled honey that day". */
  inspections: Array<{ date: string; hiveLabel: string }>;
}

export interface ScaleUploadResult {
  scaleId: string;
  sourceFile: string;
  weightUnit: "lb" | "kg";
  rowsParsed: number;
  rowsSkipped: number;
  daysStored: number;
  firstDate: string;
  lastDate: string;
}

export function useScales(apiaryId: string) {
  return useQuery({
    queryKey: ["apiaries", "detail", apiaryId, "scales"],
    queryFn: () => api.get<YardScale[]>(`/apiaries/${apiaryId}/scales`),
  });
}

export function useScaleSeries(
  apiaryId: string,
  range: { from?: string; to?: string } = {},
) {
  return useQuery({
    queryKey: [
      "apiaries",
      "detail",
      apiaryId,
      "scale-series",
      range.from ?? "default",
      range.to ?? "today",
    ],
    queryFn: () =>
      api.get<ScaleSeriesResponse>(`/apiaries/${apiaryId}/scale-series`, {
        params: { from: range.from, to: range.to },
      }),
  });
}

function useInvalidateScales(apiaryId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: ["apiaries", "detail", apiaryId, "scales"],
    });
    void queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey.includes("scale-series"),
    });
  };
}

export function useCreateScale(apiaryId: string) {
  const invalidate = useInvalidateScales(apiaryId);
  return useMutation({
    mutationFn: (payload: {
      name: string;
      vendor: ScaleVendor;
      deviceId?: string | null;
      hiveId?: string | null;
      notes?: string | null;
    }) =>
      api.post<{ id: string; success: boolean }>(
        `/apiaries/${apiaryId}/scales`,
        payload,
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteScale(apiaryId: string) {
  const invalidate = useInvalidateScales(apiaryId);
  return useMutation({
    mutationFn: (scaleId: string) =>
      api.delete<{ success: boolean }>(`/scales/${scaleId}`),
    onSuccess: invalidate,
  });
}

// The typed api wrapper is JSON-only, so the CSV posts its FormData directly
// (same-origin cookies still flow). Same shape as the photo upload.
function redirectToLogin() {
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/login")) return;
  window.location.assign("/login");
}

async function uploadScaleCsv(input: {
  scaleId: string;
  file: File;
  weightUnit: "lb" | "kg";
}): Promise<ScaleUploadResult> {
  const body = new FormData();
  body.append("file", input.file);
  body.append("weightUnit", input.weightUnit);

  const res = await fetch(`/api/v1/scales/${input.scaleId}/readings`, {
    method: "POST",
    credentials: "include",
    body,
  });
  let data: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    const message =
      (data as { error?: string } | null)?.error ??
      `Upload failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return data as ScaleUploadResult;
}

export function useUploadScaleReadings(apiaryId: string) {
  const invalidate = useInvalidateScales(apiaryId);
  return useMutation({
    mutationFn: uploadScaleCsv,
    onSuccess: invalidate,
  });
}
