"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export interface StorageSettings {
  defaultBackend: string;
  fallbackBackend: string;
  immichConfigured: boolean;
  immichHealthy: boolean | null;
  immichError?: string | null;
  counts: { minio: number; immich: number };
}

export function StorageSection() {
  const storage = useQuery({
    queryKey: ["settings", "storage"],
    queryFn: () => api.get<StorageSettings>("/settings/storage"),
  });

  if (storage.isPending) {
    return <Skeleton className="h-28 w-full" />;
  }
  if (storage.isError || !storage.data) {
    return (
      <p className="text-sm text-destructive">
        Could not load photo storage settings.
      </p>
    );
  }

  const data = storage.data;
  const health =
    !data.immichConfigured
      ? "not configured"
      : data.immichHealthy === true
        ? "reachable"
        : data.immichHealthy === false
          ? "unreachable"
          : "unknown";

  return (
    <div className="grid gap-3 text-sm" data-config-editor="photo-storage">
      <div className="grid gap-1">
        <p>
          Default backend:{" "}
          <span className="font-medium">{data.defaultBackend}</span>
        </p>
        <p>
          Fallback:{" "}
          <span className="font-medium">{data.fallbackBackend}</span>
        </p>
        <p>
          Immich: <span className="font-medium">{health}</span>
          {data.immichError ? ` — ${data.immichError}` : ""}
        </p>
        <p>
          Photos: {data.counts.minio} MinIO, {data.counts.immich} Immich
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start"
        onClick={() => void storage.refetch()}
        disabled={storage.isFetching}
      >
        <RefreshCw className={storage.isFetching ? "animate-spin" : ""} />
        Check Immich
      </Button>
    </div>
  );
}
