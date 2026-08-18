"use client";

import {
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

export function usePhotoLibrary(enabled: boolean, page = 1) {
  return useQuery({
    queryKey: ["photos", "library", page],
    queryFn: () =>
      api.get<{ items: LibraryAsset[]; nextPage: string }>(
        "/photos/library",
        { params: { page, size: 24 } },
      ),
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
    }) => api.post<{ success: boolean; photoId: string }>("/photos/link", input),
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
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: string;
      caption?: string | null;
      tags?: string[];
    }) => api.patch<{ success: boolean }>(`/photos/${id}`, payload),
    onSuccess: () => invalidate(ownerType, ownerId),
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
        throw new Error(`${failed} of ${ids.length} photos could not be deleted`);
      }
      return ids.length;
    },
    onSettled: () => invalidate(ownerType, ownerId),
  });
}
