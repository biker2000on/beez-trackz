"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, OfflineQueuedError, type ApiResponseMeta } from "@/lib/api";

import type {
  ProductionWorkbenchResponse,
  SalesWorkbenchResponse,
  WorkCommand,
  WorkFreshness,
} from "./types";

/**
 * One client over `GET /production/workbench` and `GET /sales/workbench`.
 *
 * Both are §4.8 read models: one call each, permission-filtered and
 * ledger-sourced server-side. There is deliberately no second query in this
 * module — a per-widget fetch here would put the workbench back in the
 * position the dashboard was in, assembling a screen out of four reads that
 * can disagree with one another about the same jar.
 */

/**
 * The server always reports `origin: "server"` — it cannot know it was
 * replayed from a cache. `X-Beez-Cache: stale` (`sw.js/route.ts:400`) is the
 * only evidence a body is not current (§4.5).
 *
 * This is the same rule `features/work/api.ts` applies to the field slice.
 * It is restated rather than imported because that module keeps it private
 * and belongs to wave 2; when `features/work` is next opened (wave 5, the
 * route rewrite) the two should collapse into one exported helper.
 */
function cacheFreshness(meta: ApiResponseMeta): WorkFreshness | null {
  if (meta.cache !== "stale") return null;
  return {
    origin: "cache",
    cachedAt: meta.date ? meta.date.toISOString() : null,
    stale: true,
  };
}

function markFreshness<T extends { freshness: WorkFreshness }>(
  response: T,
  meta: ApiResponseMeta,
): T {
  const freshness = cacheFreshness(meta);
  return freshness ? { ...response, freshness } : response;
}

function yearParams(year?: number): Record<string, string> {
  return year ? { year: String(year) } : {};
}

export function workbenchQueryKey(model: "production" | "sales", year?: number) {
  return ["workbench", model, year ?? "current"] as const;
}

export function useProductionWorkbench(year?: number) {
  return useQuery({
    queryKey: workbenchQueryKey("production", year),
    queryFn: async () => {
      const result = await api.getWithMeta<ProductionWorkbenchResponse>(
        "/production/workbench",
        { params: yearParams(year) },
      );
      return markFreshness(result.data, result.meta);
    },
  });
}

export function useSalesWorkbench(year?: number) {
  return useQuery({
    queryKey: workbenchQueryKey("sales", year),
    queryFn: async () => {
      const result = await api.getWithMeta<SalesWorkbenchResponse>(
        "/sales/workbench",
        { params: yearParams(year) },
      );
      return markFreshness(result.data, result.meta);
    },
  });
}

/** The outcome of running a command; `queued` is the offline receipt path. */
export interface CommandOutcome {
  queued: boolean;
  mutationId?: string;
}

/**
 * Substitute this attempt's client mutation id into the command's key
 * template, so the header the service worker replays is bound to the
 * command's own identity (§5.1) rather than to whichever button was pressed.
 */
function mutationIdFor(command: WorkCommand): string {
  const clientMutationId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return command.idempotencyKeyTemplate.replace(
    "{clientMutationId}",
    clientMutationId,
  );
}

/**
 * Execute a workbench command — its own method and path, verbatim.
 *
 * Identical in behaviour to `features/work`'s `useRunWorkCommand`, and
 * deliberately a separate hook: that one takes a `WorkItem` it does not use
 * and invalidates the field-slice caches, while a bottling run has to
 * invalidate the honey, commerce and stock-location caches instead. Sharing
 * it would mean either editing wave-2 code or leaving Production showing the
 * pre-command world.
 *
 * There is no `PUT /workbench` (§4.8): every mutation on these screens is the
 * source command the read model named.
 */
export function useRunWorkbenchCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      command,
    }: {
      command: WorkCommand;
    }): Promise<CommandOutcome> => {
      const mutationId = mutationIdFor(command);
      try {
        await api.send(command.method, command.path, command.bodyTemplate, {
          headers: { "X-Offline-Mutation-ID": mutationId },
        });
        return { queued: false, mutationId };
      } catch (error) {
        // 202 with a queue receipt is not a failure: the service worker took
        // the mutation for replay. It is neither a success nor a failure and
        // is reported as neither.
        if (error instanceof OfflineQueuedError) {
          return { queued: true, mutationId: error.mutationId ?? mutationId };
        }
        throw error;
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbench"] });
      // The owning domains keep their own views (the lots tab, the jars tab,
      // the consignment page); a command run from a workbench must not leave
      // them showing the pre-command world.
      void queryClient.invalidateQueries({ queryKey: ["honey"] });
      void queryClient.invalidateQueries({ queryKey: ["commerce"] });
      void queryClient.invalidateQueries({ queryKey: ["harvest-sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["harvests"] });
      void queryClient.invalidateQueries({ queryKey: ["stock-locations"] });
      void queryClient.invalidateQueries({ queryKey: ["product-batches"] });
      // Finished stock and packaging draws are ledger movements; Today and
      // the yard queue can carry a harvest-ready item about the same lot.
      void queryClient.invalidateQueries({ queryKey: ["work"] });
    },
  });
}
