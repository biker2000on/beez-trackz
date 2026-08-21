"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { ApiError, api } from "@/lib/api";

// Same-origin multipart posts skip the JSON api wrapper, so they must
// redirect on 401 themselves (api.ts handleUnauthorized is not used here).
let redirectingToLogin = false;

function handleUnauthorized(path: string) {
  if (typeof window === "undefined" || redirectingToLogin) return;
  if (path.startsWith("/auth/") || path.startsWith("auth/")) return;
  if (window.location.pathname.startsWith("/login")) return;
  redirectingToLogin = true;
  window.location.assign("/login");
}

// --- types (mirror backend/internal/httpapi/routes_photos.go) ---

export type PhotoOwnerType = "hive" | "apiary" | "inspection";

export interface Photo {
  id: string;
  ownerType: PhotoOwnerType;
  ownerId: string;
  caption: string | null;
  tags: string[] | null;
  takenDate: string | null;
  createdAt: string;
  originalUrl: string | null;
  thumbnailUrl: string | null;
  mediumUrl: string | null;
  storageBackend?: "minio" | "immich";
  originalExternal?: boolean;
  comparisonAngle?: string | null;
}

export interface TimelinePhoto extends Photo {
  matchedTerms: string[];
}

export type TimelineReviewReason =
  | "missing_gps"
  | "multiple_apiaries"
  | "flora_or_bees_needs_review"
  | "no_longer_matched"
  | "rendition_enqueue_failed"
  | string;

export interface TimelineCandidate {
  id: string;
  immichAssetId: string;
  originalFilename: string | null;
  takenDate: string | null;
  latitude: number | null;
  longitude: number | null;
  matchedTerms: string[];
  nearbyApiaryIds: string[];
  reviewReason: TimelineReviewReason;
  thumbnailUrl: string;
}

export interface TimelineScan {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  matchedCount: number;
  adoptedCount: number;
  reviewCount: number;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ApiaryPhotoTimeline {
  photos: TimelinePhoto[];
  review: TimelineCandidate[];
  latestScan: TimelineScan | null;
}

export interface PhotoStorageInfo {
  defaultBackend: "minio" | "immich";
  fallbackBackend: "minio";
  immichConfigured: boolean;
}

export interface LibraryAsset {
  id: string;
  originalFileName: string;
  takenAt?: string | null;
  thumbnailUrl: string;
}

export function usePhotoStorage() {
  return useQuery({
    queryKey: ["photos", "storage"],
    queryFn: () => api.get<PhotoStorageInfo>("/photos/storage"),
  });
}

/** Pages through the Immich library; `nextPage` from the API drives "load more". */
export function usePhotoLibrary(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["photos", "library"],
    queryFn: ({ pageParam }) =>
      api.get<{ items: LibraryAsset[]; nextPage: string }>("/photos/library", {
        params: { page: pageParam, size: 24 },
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => {
      const next = Number.parseInt(last.nextPage, 10);
      return Number.isFinite(next) && next > 0 ? next : undefined;
    },
    enabled,
  });
}

export function usePhotos(ownerType: PhotoOwnerType, ownerId: string) {
  return useQuery({
    queryKey: ["photos", ownerType, ownerId],
    queryFn: () =>
      api.get<Photo[]>("/photos", { params: { ownerType, ownerId } }),
  });
}

export function useApiaryPhotoTimeline(apiaryId: string) {
  return useQuery({
    queryKey: ["photos", "timeline", apiaryId],
    queryFn: () =>
      api.get<ApiaryPhotoTimeline>(`/apiaries/${apiaryId}/photos/timeline`),
    refetchInterval: (query) => {
      const status = query.state.data?.latestScan?.status;
      return status === "queued" || status === "running" ? 2_000 : false;
    },
  });
}

export function useScanApiaryPhotos(apiaryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ queued: boolean; scanId: string; alreadyActive: boolean }>(
        `/apiaries/${apiaryId}/photos/scan`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["photos", "timeline", apiaryId],
      }),
  });
}

export function useReviewTimelinePhoto(apiaryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      candidateId,
      action,
    }: {
      candidateId: string;
      action: "adopt" | "reject";
    }) =>
      api.post<{ success: boolean; photoId?: string }>(
        `/apiaries/${apiaryId}/photos/review/${candidateId}`,
        { action },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["photos", "timeline", apiaryId],
      }),
  });
}

export function useHivePhotoStrip(hiveId: string) {
  return useQuery({
    queryKey: ["photos", "strip", hiveId],
    queryFn: () => api.get<Photo[]>(`/hives/${hiveId}/photos/strip`),
  });
}

/**
 * Multipart upload — the typed api wrapper is JSON-only, so this posts the
 * FormData directly (same-origin cookies still flow).
 */
async function uploadPhoto(input: {
  file: File;
  ownerType: PhotoOwnerType;
  ownerId: string;
  caption?: string;
}): Promise<{ success: boolean; photoId: string }> {
  const body = new FormData();
  body.append("file", input.file);
  body.append("ownerType", input.ownerType);
  body.append("ownerId", input.ownerId);
  if (input.caption?.trim()) body.append("caption", input.caption.trim());

  const res = await fetch("/api/v1/photos", {
    method: "POST",
    credentials: "include",
    body,
  });
  let data: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized("/photos");
    const message =
      (data as { error?: string } | null)?.error ??
      `Upload failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return data as { success: boolean; photoId: string };
}

function useInvalidatePhotos() {
  const queryClient = useQueryClient();
  return (ownerType: PhotoOwnerType, ownerId: string) => {
    void queryClient.invalidateQueries({
      queryKey: ["photos", ownerType, ownerId],
    });
  };
}

export function useLinkPhoto() {
  const invalidate = useInvalidatePhotos();
  return useMutation({
    mutationFn: (input: {
      assetId: string;
      ownerType: PhotoOwnerType;
      ownerId: string;
      caption?: string;
      takenDate?: string | null;
    }) =>
      api.post<{ success: boolean; photoId: string }>("/photos/link", input),
    onSuccess: (_data, variables) => {
      invalidate(variables.ownerType, variables.ownerId);
    },
  });
}

export function useUploadPhoto() {
  const invalidate = useInvalidatePhotos();
  return useMutation({
    mutationFn: uploadPhoto,
    onSuccess: (_data, variables) => {
      invalidate(variables.ownerType, variables.ownerId);
    },
  });
}

export function useUpdatePhoto(ownerType: PhotoOwnerType, ownerId: string) {
  const invalidate = useInvalidatePhotos();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: string;
      caption?: string | null;
      tags?: string[];
      comparisonAngle?: string;
    }) => api.patch<{ success: boolean }>(`/photos/${id}`, payload),
    onSuccess: () => {
      invalidate(ownerType, ownerId);
      if (ownerType === "hive") {
        void queryClient.invalidateQueries({
          queryKey: ["photos", "strip", ownerId],
        });
      }
    },
  });
}

export function useReprocessPhoto(
  ownerType: PhotoOwnerType,
  ownerId: string,
) {
  const invalidate = useInvalidatePhotos();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ queued: boolean }>(`/photos/${id}/reprocess`),
    onSuccess: () => {
      invalidate(ownerType, ownerId);
      if (ownerType === "hive") {
        void queryClient.invalidateQueries({
          queryKey: ["photos", "strip", ownerId],
        });
      }
    },
  });
}

export function useDeletePhoto(ownerType: PhotoOwnerType, ownerId: string) {
  const invalidate = useInvalidatePhotos();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/photos/${id}`),
    onSuccess: () => invalidate(ownerType, ownerId),
  });
}

export function useBulkDeletePhotos(
  ownerType: PhotoOwnerType,
  ownerId: string,
) {
  const invalidate = useInvalidatePhotos();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.delete<{ success: boolean }>(`/photos/${id}`)),
      );
      const failed = results.filter(
        (result) => result.status === "rejected",
      ).length;
      if (failed > 0) {
        throw new Error(
          `${failed} of ${ids.length} photos could not be deleted`,
        );
      }
      return ids.length;
    },
    onSettled: () => invalidate(ownerType, ownerId),
  });
}
