"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";

import type {
  CanvasHive,
  CanvasLayout,
  HivePlacement,
  SlotTarget,
} from "./types";

/** Shape of GET /apiaries/{id} (the fields the canvas cares about). */
export interface ApiaryDetail {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  elevationM: number | null;
  elevationSource: string | null;
  notes: string | null;
  canvasLayout: unknown;
}

export const apiaryQueryKey = (apiaryId: string) => ["apiaries", apiaryId];
export const hivesQueryKey = (apiaryId: string) => [
  "hives",
  "list",
  { apiaryId },
];

export function useApiary(apiaryId: string) {
  return useQuery({
    queryKey: apiaryQueryKey(apiaryId),
    queryFn: () => api.get<ApiaryDetail>(`/apiaries/${apiaryId}`),
  });
}

export function useApiaryHives(apiaryId: string) {
  return useQuery({
    queryKey: hivesQueryKey(apiaryId),
    queryFn: () =>
      api.get<CanvasHive[]>("/hives", { params: { apiaryId } }),
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * Write-through canvas operations. Occupancy writes hit the API immediately
 * and refresh the hives query; layout saves persist the geometry blob.
 */
export function useCanvasApi(apiaryId: string) {
  const queryClient = useQueryClient();

  const refreshHives = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["hives"] }),
    [queryClient],
  );

  const saveLayout = useCallback(
    async (layout: CanvasLayout) => {
      await api.put(`/apiaries/${apiaryId}/canvas-layout`, layout);
      // Sync every cached copy of this apiary; otherwise a remount within
      // staleTime restores the stale blob and the next autosave overwrites
      // the geometry we just saved. (The apiaries feature caches the same
      // resource under a second key.) The apiary pin is operator-set and is
      // not derived from stands, so it is left alone here.
      const patch = (old: unknown) =>
        old && typeof old === "object"
          ? { ...(old as ApiaryDetail), canvasLayout: layout }
          : old;
      queryClient.setQueryData(apiaryQueryKey(apiaryId), patch);
      queryClient.setQueryData(["apiaries", "detail", apiaryId], patch);
    },
    [apiaryId, queryClient],
  );

  const createHiveInSlot = useCallback(
    async (target: SlotTarget) => {
      try {
        await api.post("/canvas/hives", {
          apiaryId,
          standId: target.standId,
          standLabel: target.standLabel,
          slotRow: target.row,
          slotCol: target.col,
          standCols: target.standCols,
        });
        await refreshHives();
      } catch (error) {
        toast.error(errorMessage(error, "Could not create the hive."));
      }
    },
    [apiaryId, refreshHives],
  );

  const updateHive = useCallback(
    async (
      hiveId: string,
      data: {
        positionLabel: string;
        status: string;
        notes: string;
        placement?: HivePlacement;
      },
    ) => {
      try {
        await api.patch(`/canvas/hives/${hiveId}`, data);
        await refreshHives();
        return true;
      } catch (error) {
        toast.error(errorMessage(error, "Could not update the hive."));
        return false;
      }
    },
    [refreshHives],
  );

  const assignSlot = useCallback(
    async (
      hiveId: string,
      target: SlotTarget,
      placement: HivePlacement = "full",
    ) => {
      try {
        await api.post(`/canvas/hives/${hiveId}/assign-slot`, {
          apiaryId,
          standId: target.standId,
          standLabel: target.standLabel,
          slotRow: target.row,
          slotCol: target.col,
          standCols: target.standCols,
          placement,
        });
        await refreshHives();
      } catch (error) {
        toast.error(errorMessage(error, "Could not move the hive."));
      }
    },
    [apiaryId, refreshHives],
  );

  const setPlacement = useCallback(
    async (hiveId: string, placement: HivePlacement) => {
      try {
        await api.post(`/canvas/hives/${hiveId}/placement`, { placement });
        await refreshHives();
      } catch (error) {
        toast.error(errorMessage(error, "Could not update hive placement."));
      }
    },
    [refreshHives],
  );

  const removeFromSlot = useCallback(
    async (hiveId: string) => {
      try {
        await api.post(`/canvas/hives/${hiveId}/remove-slot`);
        await refreshHives();
      } catch (error) {
        toast.error(errorMessage(error, "Could not remove the hive from its slot."));
      }
    },
    [refreshHives],
  );

  const setFacing = useCallback(
    async (hiveId: string, facingDegrees: number) => {
      try {
        await api.post(`/canvas/hives/${hiveId}/facing`, { facingDegrees });
        await refreshHives();
      } catch (error) {
        toast.error(errorMessage(error, "Could not set the facing direction."));
      }
    },
    [refreshHives],
  );

  return {
    saveLayout,
    createHiveInSlot,
    updateHive,
    assignSlot,
    setPlacement,
    removeFromSlot,
    setFacing,
  };
}
