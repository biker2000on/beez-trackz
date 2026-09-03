"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, OfflineQueuedError, type ApiResponseMeta } from "@/lib/api";

import type {
  TodayResponse,
  WorkCommand,
  WorkFilter,
  WorkFreshness,
  WorkItem,
  YardResponse,
} from "./types";

/**
 * One client over `GET /work/today` and `GET /work/yard`. Both read models
 * are the same projection under a different grouping, so they share the
 * filter, the freshness handling and the command executor; nothing here
 * decides what an item *is*.
 */

function filterParams(filter: WorkFilter): Record<string, string> {
  const params: Record<string, string> = {};
  // The server accepts repeated or comma-separated values (routes_work.go
  // csvValues); comma keeps the query key — and therefore the SW cache key —
  // stable for the same filter.
  if (filter.status?.length) params.status = filter.status.join(",");
  if (filter.priority?.length) params.priority = filter.priority.join(",");
  if (filter.sourceType?.length) params.sourceType = filter.sourceType.join(",");
  if (filter.apiaryId) params.apiaryId = filter.apiaryId;
  return params;
}

/**
 * The server always reports `origin: "server"` — it cannot know it was
 * replayed from a cache. When the service worker served this body it stamps
 * `X-Beez-Cache: stale` (`sw.js/route.ts:400`); that header is the only
 * evidence a response is not current, so it is applied here, once, to the
 * response and to every item inside it (§4.5).
 */
function cacheFreshness(meta: ApiResponseMeta): WorkFreshness | null {
  if (meta.cache !== "stale") return null;
  return {
    origin: "cache",
    cachedAt: meta.date ? meta.date.toISOString() : null,
    stale: true,
  };
}

function applyFreshnessToItems(
  items: WorkItem[],
  freshness: WorkFreshness,
): WorkItem[] {
  return items.map((item) => ({ ...item, freshness }));
}

function markToday(
  response: TodayResponse,
  meta: ApiResponseMeta,
): TodayResponse {
  const freshness = cacheFreshness(meta);
  if (!freshness) return response;
  return {
    ...response,
    freshness,
    groups: response.groups.map((group) => ({
      ...group,
      items: applyFreshnessToItems(group.items, freshness),
    })),
  };
}

function markYard(response: YardResponse, meta: ApiResponseMeta): YardResponse {
  const freshness = cacheFreshness(meta);
  if (!freshness) return response;
  return {
    ...response,
    freshness,
    yards: response.yards.map((yard) => ({
      ...yard,
      items: applyFreshnessToItems(yard.items, freshness),
    })),
  };
}

export function workQueryKey(model: "today" | "yard", filter: WorkFilter) {
  return ["work", model, filterParams(filter)] as const;
}

/** Options shared by both read models. `enabled` gates a secondary read. */
export interface WorkQueryOptions {
  enabled?: boolean;
}

export function useWorkToday(
  filter: WorkFilter = {},
  options: WorkQueryOptions = {},
) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: workQueryKey("today", filter),
    queryFn: async () => {
      const result = await api.getWithMeta<TodayResponse>("/work/today", {
        params: filterParams(filter),
      });
      return markToday(result.data, result.meta);
    },
  });
}

export function useWorkYard(
  filter: WorkFilter = {},
  options: WorkQueryOptions = {},
) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: workQueryKey("yard", filter),
    queryFn: async () => {
      const result = await api.getWithMeta<YardResponse>("/work/yard", {
        params: filterParams(filter),
      });
      return markYard(result.data, result.meta);
    },
  });
}

/**
 * The outcome of running a command. `queued` is the offline receipt path:
 * the service worker accepted the mutation for replay and answered 202, which
 * is neither success nor failure and must not be rendered as either.
 */
export interface CommandOutcome {
  queued: boolean;
  mutationId?: string;
}

/** Substitute this attempt's mutation id into the command's key template. */
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
 * Execute a work item's command — its own method and path, verbatim.
 *
 * There is deliberately no generic work-item mutation endpoint: a work item
 * is a projection, and the durable change belongs to the domain the command
 * names (§4.8, "Mutations remain explicit source commands"). The mutation id
 * is derived from `idempotencyKeyTemplate`, so a replay from the offline
 * queue resolves to the same command identity (§5.1); the service worker
 * honours an `X-Offline-Mutation-ID` the caller supplies
 * (`sw.js/route.ts:64`) rather than inventing its own.
 */
export function useRunWorkCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      command,
    }: {
      item: WorkItem;
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
        // the mutation for replay. Reporting it as an error would tell the
        // operator the work did not happen, and reporting it as a success
        // would tell them it did. It is neither, and says so.
        if (error instanceof OfflineQueuedError) {
          return { queued: true, mutationId: error.mutationId ?? mutationId };
        }
        throw error;
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["work"] });
      // The source domains still have their own views (the recommendations
      // triage page, the feeding list); a command executed from Today must
      // not leave them showing the pre-command world.
      void queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      void queryClient.invalidateQueries({ queryKey: ["feedings"] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}
